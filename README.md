# GitLab Todo Watcher

一个持久化 DSH Bundle：在左侧栏添加 **GitLab Todo** 页面，由 Host 直接通过 `glab` 定时读取 Todo，并将需要处理的事项分派到真实 DSH Session。不再需要 Python 或外置轮询脚本。

## 使用

1. 确保 `glab` 已登录且能访问目标 GitLab。
2. 打开左侧 **GitLab Todo** 页面。插件默认停用，不会安装后立即创建 Session。
3. 在 **设置** 中配置轮询间隔、每轮上限与自动处理并发数（默认 2）；也可直接用页头的模型下拉选择新会话模型。确认后再启用自动轮询。
4. 状态栏下方直接显示可区域滚动的 Todo 列表；带有 **评论中 @ 我** 标签的事项会进入自动处理范围。
5. Session 内的 Agent 只有在实际完成后，才会按提示调用 `POST /todos/:id/mark_as_done`。

## 内置轮询与识别规则

Host 每次轮询先通过 `glab api user` 获取并缓存当前用户 ID，再使用只读的 `glab api -X GET todos` 分页读取当前用户的待办，每页 100 条、最多 20 页。响应由 Host 直接解析、校验和归一化。

只有同时满足以下条件的 Todo 才属于“他人在评论中直接 @ 我”：

- `action_name=directly_addressed`：GitLab 将其识别为直接提及，而不是普通提及、指派或其他通知。
- `target_url` 包含 `#note_<id>`：Todo 来源于评论，而不是 Issue/MR 描述。
- `author.id` 不等于当前用户 ID：排除自己在评论中 @ 自己产生的 Todo。

该规则不限制 Issue、WorkItem 或 MergeRequest。普通 `mentioned`、指派、评审请求和其他通知仅保留在列表中，不自动创建 Session。

## 分类与处理规则

- **符合条件的评论直接提及**：在“启用轮询”和“自动创建 Session”同时开启时，按每轮上限选取 Todo 进入分派队列，由后台队列逐条分派。**自动处理并发数**（默认 2，可设 1–10）限制的是插件自动创建的 Session 中**同时处于运行状态**的数量：一个会话本次执行真正结算（回合完成或失败）后，队列才会启动下一条，跨轮次同样生效。手动点击“开 Session 处理/重新处理”是显式人工动作，不占用也不受该上限约束。
- 页面状态栏显示 **自动会话运行中 x/上限** 与 **排队待分派** 数量；页头提供模型快捷下拉，改动立即保存，无需打开设置。
- **符合条件的 MR 评论提及**：同样创建 Session，不再因为目标是 MR 而直接标记完成。
- **其他 MR**：不自动处理；人工点击“标记完成”时，插件执行 `glab api -X POST todos/:id/mark_as_done` 并记录为 `merge-request-done`。
- **其他类型或提及方式**：只保留在列表中，不自动处理；人工点击“开 Session 处理”时才创建 Session。
- 手动“立即检查”只刷新结果，不触发自动分派。
- 已接受的 Todo 可通过列表中的 **打开 Session** 进入对应会话；“重新处理”是显式人工动作。

## Session 处理后的回复与完成标记

每个处理提示词都会携带 Todo ID、原 note ID、目标 URL 和 note 作者，并明确要求：

1. 正常处理结束后，在原 note 所属的 discussion 中回复提出该 note 的人，说明处理结果、实际改动或阻塞原因，而不是只新建顶层评论。
2. 只有实际完成该 Todo 后，才运行 `glab api -X POST todos/<todo-id>/mark_as_done`，仅标记当前这一条 Todo。
3. 无法完成、需要人类决策或未获发布授权时，不运行完成命令；正常情况下仍应在原 note 回应进度和阻塞原因。

## DSH 会话交互（对齐 dsh-task-board 实现）

插件与 DSH 的全部会话操作都经 **typertGateway** 以 Host 本地 owner peer 调用（`session/modelCatalog|create|rename|selectModel|prompt|list|page` 与流式 `session/follow`），不使用浏览器传入的身份，与 [dsh-task-board](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-task-board) 的 HostExecutionRunner 同一调用契约。

**执行结算**：prompt 入队只代表“已接受”，不是完成。Host 定期（默认 5 秒，仅在有运行中会话或排队任务时轮询）读取会话名册：`running=true` 仍在执行；空闲后经 `session/follow` 开场帧与 `session/page` 有界回翻，找本次启动之后最早的 `turn/end`，只有 `data.reason.kind === 'completed'` 才记为执行完成，其余（error/interrupted/max-tokens 等）记为执行失败；名册读取失败一律视为“仍在执行”，绝不误判为空闲。连续 24 轮读不到历史才按失败收口，避免永久占用。

**并发槽位**：只有插件自动分派的会话计入并发上限；槽位从会话创建占用到本次执行真正结算（完成/失败/消失），跨轮次生效。手动“开 Session 处理”是显式人工动作，不计入也不受上限约束，但执行中禁止再次重新处理同一 Todo。

## 新会话配置

- **新开会话的工作区文件夹**：须为 DSH 已注册的工作区路径（经 `workspaceRegistry` 解析为 `workspaceId` 传给 `session/create`）；未命中会显式报错，留空使用最近使用的工作区，绝不落回 Host 进程目录。它与 **GitLab 工作目录** 相互独立。
- **新开会话使用的模型**：直接遍历 Host 模型目录返回的全部模型分组；创建 Session 后依次执行 `session/rename`（以 Todo 标题命名）与 `selectModel({ provider, model })`，再提交提示词。选择具体模型（包括“固定当前默认模型”）会固定该路由，不随 DSH 默认模型变化。
- 设置保存在 `state.json`，不修改已接受的历史 Session。工作区只在创建时确定；pending Session 重试会复用原工作区，但会重新应用当前模型配置。

## 存储与升级

设置、Todo 去重和 Session 链接保存在 `~/.dsh-plugins/gitlabtodo/state.json`，采用原子写入，重启后恢复。插件不再创建 `gitlab-todos.py`、临时脚本目录或脚本编辑区域。

旧版 v1/v2 状态会在首次启动时自动升级为 v3：移除 `shell`、`script` 设置，保留 Todo、已处理记录、Session 链接和其他设置。

## 去重与失败恢复

- 空结果不创建 Session。
- 只有提示词入队成功后，Todo ID 才进入已处理记录（`executionStatus=running`），避免下一轮重复开会话。
- Session 已创建但提示词未入队时，记录 pending Session，下轮复用而不是重复创建。
- Host 重启后会从持久记录恢复仍在运行的会话监控，继续按回合结果结算。
- 每轮自动创建数量可设为 1–10；剩余新 Todo 留到后续轮次。

## Bridge 安全

页面通过同源 `/api/gitlab-todo-agent` 与 Host 通信，路由注册在 DSH `connection.fetch` 上。Connection 统一完成 Host/Origin 检查、签名 Cookie 认证和 Owner Peer 校验，插件不另开无认证端点，也不自行读取或保存浏览器凭据；响应禁止缓存。

## 开发验证

```sh
npm test
npm run check
```

单元测试不会处理真实 Todo 或创建真实模型会话。
