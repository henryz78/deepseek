# 部署到 Linux 服务器

思路：**登录只在你自己的电脑上做**，导出 `login.json` 上传到服务器，服务器启动时自动导入。服务器上不需要 VNC / SSH。

## 1. 本地：登录并导出（Windows/Mac/Linux 都行）

```bash
npm install
cp .env.example .env        # 填 CLOAKBROWSER_LICENSE_KEY
npm run export-login        # 没登录会弹窗让你登录；成功后生成 login.json
```

- 导出前先停掉本地的服务（免费 license 同时只能开 1 个浏览器）。
- `login.json` 等于账号登录权限：别提交到仓库、别发到聊天里，只放在服务器的私有位置。

## 2. 服务器：装依赖（Debian / Ubuntu，需要 root）

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# 浏览器运行库 + 中文字体（没有中文字体页面会渲染异常）
npx playwright-core install-deps chromium
apt-get install -y fonts-noto-cjk
# 可选：想用有头模式时（见下）
apt-get install -y xvfb
```

`install-deps` 失败的话，手动装：`libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2`（包名随发行版略有差异）。

## 3. 服务器：放文件并启动

```bash
# 代码目录里放：代码、.env、login.json
npm install
npm start                   # 首次会下载约 500MB 的浏览器二进制
```

`.env` 里服务器上至少要有：

```
CLOAKBROWSER_LICENSE_KEY=cb_...
API_KEY=一个很长的随机字符串
HOST=0.0.0.0
HEADLESS=1
```

监听非本机地址时**必须设 `API_KEY`**，否则程序拒绝启动。调用时带 `Authorization: Bearer <API_KEY>`。

首次启动日志里会出现 `imported login state (N cookies, M localStorage items)`，表示导入成功。

### 无头 / 有头

- 默认先用 `HEADLESS=1`。
- 如果发现被验证码或登录失效频繁打断，改用有头 + 虚拟显示器：去掉 `HEADLESS`，用 `xvfb-run -a npm start` 启动。不需要 VNC。
- 哪种对 DeepSeek 更不容易被风控，没有验证过，要自己观察日志。

## 4. 保持运行

进程在浏览器崩溃时会自己退出，需要平台把它拉起来。例如 systemd：

```ini
[Service]
WorkingDirectory=/opt/ds-bridge
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGTERM        # 收到 SIGTERM 会优雅关闭浏览器，释放 license 席位
```

## 5. 看状态

- `GET /health`：200 正常；503 表示浏览器挂了或需要人工处理（`blocked` 字段为 `logged_out` 或 `captcha`）。
- 每个请求一行 JSON 日志：时间、成功与否、耗时、走哪条路（`new` / `continue` / `attach`）、异常类型。

```bash
npm start 2>&1 | tee -a bridge.log
grep '"ok":false' bridge.log     # 失败的请求
```

## 6. 登录失效或遇到验证码

接口会返回 503，`error.type` 是 `logged_out` 或 `captcha`，`/health` 同时变 503。处理：

1. 在本地重新登录、过验证码（`npm run export-login`）。
2. 把新的 `login.json` 上传覆盖服务器上的文件。
3. 重启服务器上的服务（文件内容变了会自动重新导入）。

## 注意

- 机房 IP 可能比家庭 IP 更容易触发验证码，需要时设 `PROXY`。
- 服务器上的 `profile/` 不要从 Windows 拷过去：不同系统的 cookie 加密不同，拷过去基本无效。
- 这类做法违反 DeepSeek 的服务条款，账号有被限制的风险。

## 模型

网页上有"深度思考"和"智能搜索"两个独立开关，组合出 4 个模型，用 `model` 字段选：

| model | 深度思考 | 智能搜索 |
|---|---|---|
| `deepseek-web` | 关 | 关 |
| `deepseek-web-reasoner` | 开 | 关 |
| `deepseek-web-search` | 关 | 开 |
| `deepseek-web-reasoner-search` | 开 | 开 |

搜索模型的回答里引用会写成 `[1](链接)`。
