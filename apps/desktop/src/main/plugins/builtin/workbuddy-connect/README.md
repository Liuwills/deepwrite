# WorkBuddy Connect

把本机 WorkBuddy 桌面端里可用的模型接入 DeepWrite，供创作空间、素材库与技能库使用。

## 前提

- 本机已安装并登录 WorkBuddy 桌面端（国内版）。
- DeepWrite 的插件页中已启用本插件。

插件只读取 WorkBuddy 的登录态，不会修改它的任何文件，也不会另存一份密钥。

## 工作原理

1. 读取 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
   （macOS 为 `~/Library/Application Support/CodeBuddyExtension/...`）。
2. 凭据中的令牌以 AES-256-GCM 信封保存，保护密钥由 WorkBuddy 自身的 Electron
   二进制提供：以 `ELECTRON_RUN_AS_NODE=1` 运行一次，读取
   `electron_browser_workbuddy_storage` 私有绑定。
3. 在 `127.0.0.1` 的随机端口启动 OpenAI 兼容反代，只接受带本次会话随机令牌的请求。
4. 把 WorkBuddy 的模型目录注册到 DeepWrite 的模型配置，分组名为 `WorkBuddy`。

请求路径：`DeepWrite → 127.0.0.1:<port>/v1/chat/completions → copilot.tencent.com/v2/chat/completions`。
上游只接受流式请求，因此插件总是以 `stream: true` 转发；DeepWrite 需要非流式时，
插件会把 SSE 聚合成一次完整回复。

## 模型清单

- 默认读取 WorkBuddy 客户端缓存的模型目录（`~/.workbuddy/local_storage/*.info`），
  因此列表与桌面端里看到的模型一致；缓存缺失时回退到内置清单。
- 只保留对话模型：图片生成、视频生成等只有标签、没有对话元数据的条目会被过滤。
- 上下文窗口、最大输出、是否支持思考以及默认思考档位都按目录中的元数据写入模型配置。
- 上游对少数目录内模型会返回 `service info not found`，这类模型属于账号未开通，
  选择后错误会原样显示在对话里。

## 配置

| 环境变量 | 作用 |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | 显式指定登录凭据文件 |
| `WORKBUDDY_ELECTRON_BIN` | 显式指定 WorkBuddy 可执行文件（自动探测失败时使用） |
| `WORKBUDDY_CONFIG_DIR` | 显式指定 WorkBuddy 配置目录，默认 `~/.workbuddy` |

修改环境变量后需要完全退出并重启 DeepWrite。

## 限制

- 依赖 WorkBuddy 客户端接口，不是公开 API；桌面端升级后可能需要同步更新插件。
- 账号切换或令牌过期后，点击插件卡片上的“重新加载”即可重新读取登录态。
- 插件只应连接使用者自己的 WorkBuddy 账号，请遵守 WorkBuddy 的服务条款。
