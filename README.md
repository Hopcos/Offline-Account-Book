# 离线记账本 · offline-account-book

> **单文件 HTML 记账应用**：SQLite 编译为 **WebAssembly** 作为嵌入式数据库，运行于独立 **Web Worker** 线程，
> 数据可**持久化写回 HTML 文件本身**，纯浏览器离线运行，移动端优先、完全适配手机操作习惯。

| 维度 | 方案 |
| --- | --- |
| 数据库 | SQLite（`sql.js`，WASM）内嵌于 HTML，零网络依赖 |
| 多线程 | 数据引擎运行在 Web Worker，主线程只负责渲染与交互 |
| 持久化 | ① HTML 内嵌数据区（File System Access API 写回）② localStorage 镜像 ③ 状态快照 |
| 恢复 | 刷新、下次打开自动恢复数据与状态（路由、主题、滚动位置、模块顺序） |
| 端 | 移动端优先（底部弹层 / FAB / 安全区 / 44px 触达），桌面端增强（真表格 / 居中对话框） |

---

## 一、功能特性（对照需求）

### 记账模块页（首页）
> 应用名称为 **「个人记账」**（页面标题、安装后的桌面应用名一致）。
- ✅ 新建、编辑、删除记账模块；**删除有确认对话框**（明确提示级联删除范围）
- ✅ 展示每个模块的**名称、最后修改日期、金额**（金额 = 模块下全部明细之和，由 SQL 聚合计算）
- ✅ **顶部全局汇总条**：所有模块全部明细合计的 总金额 / 已支付 / 未支付（单条 SQL 聚合，滚动吸附）
- ✅ **拖动排序**：拖动卡片右侧手柄即可重排（Pointer Events，触屏/鼠标通用），顺序持久化；
  另提供"上移 / 下移"按钮作为无障碍替代路径
- ✅ 点击模块卡片进入其**记账明细列表**
- ✅ 页面左侧显示 **LOGO**，点击 LOGO 进入**设置页面**

### 记账明细列表页
- ✅ 每条明细包含：**大类、子类、名称、金额、是否支付、日期（原生年月日选择器）**
- ✅ 严格按 **大类 → 子类 → 日期** 排序（`ORDER BY category, subcategory, date`，在 SQLite/WASM 内完成），
  并自动插入"大类 · 子类"分组分隔行提升可读性
- ✅ 顶部固定汇总条：**总金额、已支付金额、未支付金额**
- ✅ 新建 / 编辑 / 删除明细（删除需确认）；大类、子类带**历史值联想**（datalist 联动）

### 设置页（点击 LOGO 进入）
- ✅ **清理数据**：两步二次确认——先确认风险，再**输入「清空」**才能执行，防止误删
- ✅ **修改 LOGO**：选择图片 → 自动等比压缩（256px，WebP/PNG）→ 存入数据库并写回 HTML；可一键恢复默认
- ✅ **导出 / 导入备份**：`.adb` 即标准 SQLite 数据库文件，**升级换新版前导出、换新后导入，已有数据不丢**（见下方"升级更新流程"）
- ✅ **添加到桌面**：安装为桌面应用，名称 **「个人记账」**、图标为设置页所设 LOGO、点击直达应用（见下方"添加到桌面"）
- ✅ 外观设置：**主题**（浅色 / 深色 / 跟随系统）、**字号**（14–24px）、**行距**（1.3–2.0）、
  **字体**（系统 / 黑体 / 衬线 / 等宽）、**页宽**（460 / 640 / 900 / 全宽）、货币符号
- ✅ 数据与同步：绑定 / 授权 / 解绑 HTML 文件、生成含数据的 HTML 副本

### 非功能
- ✅ **异步编程**：全链路 `async/await` + Promise RPC；持久化采用防抖 + 串行队列，永不阻塞 UI
- ✅ **多线程编程**：SQLite/WASM 与全部 SQL（排序、聚合、导入导出）都在线程外的 Worker 中执行
- ✅ **可扩展性 / 模块化**：源码按 `模板 / 样式 / 主程序 / Worker / 构建 / 测试` 分层，构建时合并不影响源码可维护性
- ✅ **可读性 / 设计原则 / 设计模式**：见第十、十一章
- ✅ **详细中文 README**：本文档

---

## 二、快速开始

### 方式 1：直接打开（最简单）
双击或用浏览器打开根目录的 **`index.html`** 即可使用，无需服务器、无需联网。

> ⚠️ **数据存在哪里？** 首次打开时 HTML 内的数据区是空的。**默认情况下新数据只保存在浏览器本地缓存
>（localStorage）中，index.html 文件大小不会变化**。要让数据真正内嵌进 HTML 文件，请进入
> **设置 → 数据与同步 → 绑定 HTML 文件**，在文件选择器中选中本 `index.html`：
> 绑定成功的瞬间就会写入一次（文件大小立即变化），之后每次改动约 0.5 秒后自动写回。

### 方式 2：本地静态服务（推荐，文件写回体验最佳）
```bash
# 任选其一
npm run serve          # 本仓库自带（零依赖），http://<电脑IP>:8000
npm run lan            # 局域网 HTTPS（需先装 mkcert），https://<电脑IP>:8443 —— 手机可安装到桌面
npx serve .
python -m http.server 8000
```
然后访问 `http://localhost:8000/index.html`。

> **提示**：在设置页点击「绑定 HTML 文件」后（Chrome / Edge），每次记账都会**自动把最新数据库写回该 HTML 文件**。
> 之后即使把文件拷到 U 盘、发给同事、换台电脑打开，数据都随文件走。

### 从源码构建
```bash
npm run build     # src/ + vendor/ → 单文件 index.html
npm run check     # 静态冒烟：结构、语法、WASM 引擎读写、写回逻辑
npm run e2e       # 无头浏览器端到端（需本机 Edge/Chrome，Windows 常自带）
npm test          # build + check + e2e 全量
```

---

## 三、系统架构

```
┌──────────────────────────────── 浏览器主线程 ────────────────────────────────┐
│  index.html（单文件容器）                                                   │
│                                                                            │
│  ┌─ UI 层 ─────────────────────────────────────────────────────────────┐   │
│  │  Router(hash) → Views(模块页/明细页/设置页) → 组件(弹层/对话框/Toast) │   │
│  │        │ 只读                                     │ 命令             │   │
│  │      Store(state)  ←────── 变更通知(观察者) ────────┘                 │   │
│  └─────────┬───────────────────────────────────────────────────────────┘   │
│            │ DbClient（仓库模式，Promise RPC）                              │
│  ┌─────────▼──────────────┐   ┌────── 持久化服务 ──────────────────────┐   │
│  │  Worker 消息桥(排队/分发)│   │ ① localStorage 镜像（刷新必恢复）        │   │
│  └─────────┬──────────────┘   │ ② HTML 数据区写回（File System Access） │   │
│            │ postMessage      │ ③ IndexedDB 保存文件句柄                │   │
└────────────┼──────────────────┴─────────────────────────────────────────┘   │
             │ 结构化克隆（零拷贝转移 TypedArray）                             
┌────────────▼────────────── Web Worker（独立线程）──────────────────────────┐
│  sql.js = SQLite C/C++ → WebAssembly（内嵌 base64，随 HTML 携带）           │
│  · 建库/迁移   · 全部 CRUD   · 严格排序 ORDER BY                           │
│  · 金额汇总 SUM/CASE   · 导入导出 db.export()   · 事务与级联删除            │
└────────────────────────────────────────────────────────────────────────────┘
```

**读流程**：视图 → `DbClient.call('getRecords')` → Worker 内 SQL 排序+聚合 → 结果回传 → 渲染（主线程零计算阻塞）。
**写流程**：表单校验 → `call('createRecord')` → Worker 事务提交 → 回传新状态 → 渲染 → `schedulePersist()`（防抖 500ms）→ 导出数据库 → 落盘（LS + HTML）。

---

## 四、数据持久化设计（核心）

数据只有一份真源：**SQLite 数据库字节（base64）**。它有三个落脚点：

| 层 | 位置 | 作用 | 写入时机 |
| --- | --- | --- | --- |
| **主存储** | HTML 文件内 `<script id="adb-data">` 数据区 | 真正的"存进 HTML"，文件即数据 | 防抖 500ms 后经 File System Access API 写回 |
| **镜像** | `localStorage["adb.db.v1"]` | 保证**刷新 / 未绑定文件时**也能恢复 | 每次持久化同步写入 |
| **状态快照** | `localStorage["adb.ui.v1"]` | 主题/字号等外观（首屏防闪烁）、最后路由、滚动位置 | 变更即时写入 |
| **文件句柄** | `IndexedDB["adb.kv"] → FileSystemFileHandle` | 记住绑定的 HTML 文件，下次打开继续自动同步 | 绑定时写入 |

**启动恢复优先级**（`resolveInitialB64()`）：

```
① 已绑定且已授权的 HTML 文件（用文件内 meta adb-saved-at 与镜像 savedAt 比较，取更新者）
② localStorage 镜像（校验 base64 前缀 U1FM = "SQLite format 3\0" 防损坏）
③ HTML 内嵌数据区（文件被拷贝到新环境时的入口）
④ 全新空库（自动建表）
```

**写回 HTML 的具体做法**：读取所绑定文件全文 → 用正则定位数据区与 `adb-saved-at` 时间戳 → 仅替换
数据区内容 → `createWritable()` 覆盖写入。文件的其余部分（代码、样式）永远不动。

**浏览器差异**：

| 浏览器 | 写回 HTML | 说明 |
| --- | --- | --- |
| Chrome / Edge（桌面） | ✅ 完整支持 | 绑定一次后自动同步；权限被回收时设置页会出现「重新授权」横幅 |
| Safari / Firefox | ➖ 自动降级 | 无 File System Access API 时自动走 localStorage 镜像，并提供「下载 HTML 副本」按钮（副本内嵌当前数据） |
| 任何浏览器 | ✅ | 「下载 HTML 副本」始终可用，产物是包含数据的完整单文件 |

---

## 五、数据库设计

```sql
meta       (key TEXT PRIMARY KEY, value TEXT)
           -- settings(JSON: 主题/字号/行距/字体/页宽/货币) · logo(dataURL) · lastRoute

modules   (id TEXT PK, name TEXT, sort_order INT, created_at TEXT, updated_at TEXT)
           -- sort_order 即拖拽排序结果，CREATE 时取 MAX+1

records   (id TEXT PK,
           module_id TEXT REFERENCES modules(id) ON DELETE CASCADE, -- 删除模块级联删明细
           category TEXT,      -- 大类（必填，排序键 1）
           subcategory TEXT,   -- 子类（排序键 2）
           name TEXT,
           amount_cents INT,   -- 金额以「分」存储，规避浮点误差
           paid INT,           -- 是否支付 0/1
           date TEXT,          -- YYYY-MM-DD（排序键 3）
           created_at TEXT, updated_at TEXT)

INDEX idx_records_sort(module_id, category, subcategory, date)  -- 覆盖严格排序
```

- **严格排序**在 SQL 层完成：`ORDER BY category, subcategory, date, created_at, id`（全确定性）。
- **顶部汇总**一条 SQL 完成：`SUM` + `SUM(CASE WHEN paid=1 ...)`，未支付 = 总额 − 已支付。
- **模块卡片金额与最后修改**：相关子查询一次取回（`MAX(updated_at)` 聚合模块自身与其明细）。

---

## 六、目录结构与构建

```
offline-account-book/
├── index.html                 # 构建产物：单文件应用（约 1 MB，含 655 KB WASM 数据库）
├── build.js                   # 构建脚本：注入 CSS/JS/Worker/SQL.js/WASM(base64)
├── package.json               # npm scripts
├── src/
│   ├── index.template.html    # 页面骨架模板（含 {{占位符}} 与首屏防闪烁脚本）
│   ├── css/app.css            # 全部样式：设计令牌、双主题、响应式表格、弹层、拖拽态
│   ├── js/app.js              # 主程序：Store / Router / Views / 组件 / 拖拽 / 持久化 / 同步
│   └── worker/worker.js       # 数据服务 Worker：引擎装载、RPC 处理器、SQL 领域逻辑
├── vendor/
│   ├── sql-wasm.js            # sql.js 胶水（SQLite→WASM 的官方运行时）
│   └── sql-wasm.wasm          # SQLite WebAssembly 二进制（655 KB）
├── scripts/
│   ├── check.js               # 静态冒烟：结构/语法/WASM 真实读写/写回正则
│   ├── e2e.js                 # 端到端：无头 Edge + CDP 驱动 14 步完整业务流
│   └── lan-serve.js           # 局域网 HTTP/HTTPS 服务器（手机端一键安装的地址方案）
└── README.md
```

**构建细节**（`build.js`）：
- 五个占位符注入：`{{APP_CSS}} {{APP_JS}} {{WORKER_SRC}} {{SQLJS_GLUE}} {{SQL_WASM_B64}}`
- 内联内容中的 `</script` 会被转义为 `<\/script`（合法 JS 等价写法），防止提前闭合标签；
- 使用函数式替换避免 `$&` 等正则特殊序列被误解释；存在未替换占位符则构建失败。

---

## 七、使用说明

### 记账模块页
| 操作 | 方式 |
| --- | --- |
| 新建模块 | 右下角 **＋** FAB |
| 进入明细 | 点击卡片 |
| 编辑 / 删除 / 上下移 | **长按卡片**（约 0.5s，带震动反馈）|
| 拖动排序 | 按住卡片右侧 **⋮⋮ 手柄**拖动 |
| 进入设置 | 点击左上角 **LOGO** |

### 记账明细页
- 顶部汇总条吸顶，随时可见总金额 / 已支付 / 未支付；
- 点击任意行编辑；**＋** 记一笔；金额自动按「分」换算并格式化为千分位；
- 「是否已支付」为拨动开关；日期使用系统原生年月日选择器。

### 设置页
- **主题 / 字号 / 行距 / 字体 / 页宽**：改动即时生效并写入数据库（400ms 节流）；
- **绑定 HTML 文件**：选择本页面对应的 HTML 文件后开启自动写回；解绑不影响已有数据；
- **清理所有数据**：先弹风险说明 → 再要求输入「清空」→ 执行（模块、明细、外观、LOGO 全部重置）；
- **导出 / 导入备份**：`.adb` 文件即标准 SQLite 数据库文件（可用 DB Browser for SQLite 打开），可长期归档。

### 升级更新流程（数据不丢失）

```
旧版页面 ──① 导出备份──▶ 个人记账备份-日期.adb
        ──② 用新版 index.html 覆盖旧文件──▶ 新版页面（空库）
        ──③ 导入备份──▶ 数据、模块顺序、LOGO、外观设置全部恢复
        ──④（可选）重新绑定 HTML 文件，继续自动写回
```

- 若旧版已**绑定并自动写回**：数据本就在旧 HTML 文件里，升级后只需执行 ③ 即可；
- `.adb` 是完整 SQLite 库，**导出即快照、导入即整体替换**（导入前有"覆盖确认"弹层）；
- 也可用「下载 HTML 副本」做整文件级备份：副本内嵌当前数据，拷走即带走全部数据。

### 添加到桌面（安装为「个人记账」App）

入口：**设置 → 添加到桌面 → 「立即添加 / 添加」**。**点击后直接调起系统安装确认框，一步进桌面，
全程不经过任何浏览器菜单**（这是浏览器向网页开放的唯一"直接安装"通道 `beforeinstallprompt`，
应用已做完整捕获 + 迟到事件轮询 + 系统框取消重试）。

**能力自检**：当环境不满足一键直装时，按钮会弹出 4 项实时自检清单，准确指出卡点：

1. 页面地址满足安装条件（**HTTPS / localhost**；`file://` 与普通 http 均不满足）
2. 浏览器提供「直接安装」标准接口（Chrome / Edge / Samsung ✅；**iOS 任何浏览器都不提供 —— 系统限制**）
3. 系统安装程序已就绪（`beforeinstallprompt` 已捕获）
4. 应用描述已生成（名称「个人记账」+ 设置页 LOGO 图标）

| 环境 | 行为 |
| --- | --- |
| Android Chrome / Edge / Samsung（https 或 localhost 打开） | **一键直装**：点击 → 系统安装框 → 桌面出现「个人记账」+ LOGO 图标 |
| iOS Safari | 系统不开放直接安装接口 → 自检会明确指出：「分享 → 添加到主屏幕」，名称与 LOGO 仍取自本应用配置 |
| 手机普通 http / file:// 打开 | 自检第 1 项标红并给出解决方案（改用 HTTPS 地址或本机 localhost） |
| 不提供安装接口的浏览器 | 自检第 2 项标红 —— 网页无法绕过系统安全限制写桌面图标（任何网页都做不到），需换支持的浏览器 |

**手机安装（三条路线，任选其一）** —— 浏览器只允许 HTTPS / localhost 触发安装，这是内核级安全门槛，网页无法绕过；下列方案都能让它满足：

| 路线 | 操作 | 特点 |
| --- | --- | --- |
| ① 免费 HTTPS 托管（**最简单**） | 仓库目录执行 `npx surge ./`（按提示填个邮箱，几十秒得到一个 `https://xxx.surge.sh` 地址），手机打开该地址 | 手机随时可装可用；只发布**不含数据的初始 index.html**，账目数据留在手机本地，不会上传 |
| ② 局域网 HTTPS | 电脑装 mkcert（`winget install FiloSottile.mkcert`）后执行 `npm run lan`，手机同 WiFi 打开输出的 `https://电脑IP:8443/index.html`（首次把 `.cert/rootCA.pem` 传到手机信任，或警告页点继续访问） | 全内网，不出户；需电脑开机供服务 |
| ③ 安卓 + USB 数据线 | `npm run serve` 后电脑执行 `adb reverse tcp:8000 tcp:8000`，手机浏览器打开 `http://localhost:8000/index.html`（localhost=安全地址） | 零证书；需开 USB 调试 |

满足后：**设置 → 添加到桌面 → 立即添加**，直接弹系统安装框，一步进桌面，全程不需要浏览器菜单。

> - Chrome 有"用户互动门槛"：首次打开页面请停留约 30 秒再点添加，否则自检第 3 项可能仍未就绪；
> - 数据跟着**地址（origin）**走：换了 URL（换托管/换 IP/localhost↔局域网）等于新环境，旧数据看不到——迁移请用设置页「导出备份 → 导入备份」；
> - 手机端没有 File System Access API，无法把数据写回服务器上的 HTML 文件；需要整包带走时用「下载 HTML 副本」或「导出备份」。

实现要点：
- **动态 Web App Manifest**：运行时按当前 LOGO 与主题生成（blob URL），包含 `name/short_name = 个人记账`、
  192/512 PNG 图标（LOGO 经 Canvas 栅格化，另附 maskable 版本）、`display: standalone`、`start_url`、主题色；
  更换 LOGO 或切换主题后 Manifest 自动重建；
- `<meta application-name>` 与 `apple-mobile-web-app-title` 保证各平台命名一致；
- 已安装检测（`display-mode: standalone` / iOS `navigator.standalone`）后按钮显示「已添加」。

---

## 八、移动端适配要点

- `viewport-fit=cover` + `env(safe-area-inset-*)`：刘海屏/手势条区域安全留白；
- 所有可点目标 ≥ 44×44px；输入框字号 `max(16px, 1rem)`，避免 iOS 聚焦自动放大；
- 新建/编辑一律使用**底部弹层**（滑入动画、顶部拖拽条、点背景/Esc 关闭），确认框为居中对话框；
- FAB 悬浮按钮固定于右下安全区之上；汇总条与页头吸顶（毛玻璃背景）；
- 拖拽手柄 `touch-action: none`：拖动排序时不会误触发页面滚动；长按与滚动通过 10px 位移阈值区分；
- 移动端明细表为**卡片式行布局**（CSS Grid 五区），≥720px 自动切换为真正的六列表格；
- 双主题跟随系统 `prefers-color-scheme` 实时切换；`color-scheme` 同步原生控件（日期选择器、滚动条）。

---

## 九、性能：异步与多线程

1. **多线程**：SQLite 编译产物（WASM）只在 Worker 中实例化。建库、迁移、排序、聚合、导入导出全部
   线程外执行；主线程 60fps 只做 DOM。
2. **异步**：
   - RPC 全部返回 Promise，引擎未就绪时请求自动排队（`DbClient.queue`）；
   - 持久化 = 500ms 防抖 + `persisting/persistDirty` 串行队列，避免重入与文件写竞争；
   - 设置写入 400ms 节流；页面隐藏（`visibilitychange`）与卸载（`pagehide/beforeunload`）时强制落盘；
   - 零拷贝：WASM 字节以 `Uint8Array` 结构化克隆进 Worker；数据库导出用 `Transferable` 语义传递。
3. **首屏**：内嵌 `<head>` 同步脚本先从状态快照恢复主题/字号（防 FOUC），WASM 初始化期间展示启动动画。

---

## 十、设计原则与设计模式

| 原则 / 模式 | 落地位置 |
| --- | --- |
| **关注点分离** | 模板（结构）/ CSS（表现）/ app.js（主程序逻辑）/ worker.js（数据与业务规则）四层分离 |
| **观察者模式** | 路由变更 → 视图订阅重渲染；系统主题 `matchMedia` 变化 → 外观重应用 |
| **仓库模式（Repository）** | `DbClient` 封装全部数据访问，视图不接触 SQL 与 Worker 消息细节 |
| **单例** | `DbClient`、持久化服务（模块级唯一实例） |
| **命令模式** | RPC 消息 `{id, method, params}`，可排队、可追踪、可回放错误 |
| **MVC-lite** | Store（模型）/ Views（视图）/ Router+Handlers（控制器），单向数据流 |
| **防抖 / 串行队列** | 持久化与设置保存，保证最终一致性 |
| **防御式编程** | 声明式 DOM 构造（`text` 走 `textContent`，天然防 XSS）；金额整数分；SQL 参数绑定 |
| **开闭原则** | 新增页面 = Router 加一条路由 + 一个 `renderXxx()`；新增设置项 = DEFAULT_SETTINGS 加键 + 一行 UI |

---

## 十一、测试

```bash
npm run check    # 静态冒烟（4 组 10 项）
npm run e2e      # 端到端 14 步（无头 Edge + Chrome DevTools Protocol）
npm test         # 全量
```

`e2e.js` 覆盖：启动（WASM 就绪）→ 新建模块 → 记两笔 → **严格排序断言** → **明细页汇总金额断言**
→ 六列表头断言 → **模块页顶部全局汇总断言（各模块合计 总/已付/未付）** → 主题切换 → 刷新恢复数据与状态
→ **拖拽排序 + 刷新后顺序保持**
→ **把数据库注入 HTML 文件后清空 localStorage，验证仍能从内嵌数据区完整恢复**
→ **长按进入编辑 + 删除确认** → **导出备份（校验 SQLite 文件头与文件名）**
→ **导入备份 UI 往返（DataTransfer 注入真实文件 + 覆盖确认）**
→ **清理数据两步二次确认（输错确认词必须被拒绝）**
→ **添加到桌面：file:// 指引降级 + http 环境下 Manifest 应用名/LOGO 图标/主题色/
apple-touch-icon/安装可检测性/beforeinstallprompt 全部断言** → 全程零控制台错误。

---

## 十二、浏览器兼容性与已知限制

| 能力 | Chrome/Edge ≥ 86 | Safari ≥ 15 | Firefox ≥ 105 |
| --- | --- | --- | --- |
| WASM + Worker + localStorage | ✅ | ✅ | ✅ |
| 自动写回 HTML 文件 | ✅ | ❌（降级：镜像 + 下载副本） | ❌（同左） |
| 绑定文件跨会话记忆 | ✅（IndexedDB 句柄） | — | — |
| 导出 / 导入备份 | ✅ | ✅ | ✅ |
| 添加到桌面（PWA） | ✅（http/localhost 下） | iOS「添加到主屏幕」✅ | 有限（可创建快捷方式） |

- **权限特性**：绑定文件的授权不会永远有效；Chrome 出于安全在新会话可能要求重新点击「重新授权」（页面会有横幅提示）。
- **单标签页建议**：两个标签页同时打开同一 HTML 文件时，以最后写入者为准（未做多标签协同合并）。
- **数据区完整性**：镜像与内嵌数据均以 `SQLite format 3` 文件头做快速校验，损坏时自动重建空库而不是崩溃。

---

## 十三、常见问题（FAQ）

**Q：换了电脑 / 文件拷到手机，数据还在吗？**
A: 在。设置页「生成并下载」得到的 HTML、或已开启自动写回的 HTML，数据区里就是完整数据库；新环境打开即恢复。

**Q：为什么提示「与 HTML 文件的同步需要重新授权」？**
A: 浏览器回收了文件访问权限。点横幅或设置页的「重新授权」按钮即可（必须由你点击，浏览器不允许自动弹出）。

**Q：数据存在哪里？会上传吗？**
A: 全程离线：数据只存在于 HTML 文件数据区与浏览器本地存储（localStorage/IndexedDB），无任何网络请求。

**Q：添加了数据，但 index.html 文件大小一直没变——数据存到哪里去了？**
A: 没有绑定文件时，数据不会写入 HTML，而是保存在**浏览器本地缓存**里（Win11 实际路径）：

| 内容 | 位置 |
| --- | --- |
| 数据库整库镜像 `adb.db.v1` + 状态快照 `adb.ui.v1` | Edge：`C:\Users\<用户名>\AppData\Local\Microsoft\Edge\User Data\Default\Local Storage\leveldb\`<br>Chrome：`C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data\Default\Local Storage\leveldb\` |
| 绑定文件的句柄 `html-handle`（绑定后才有） | 同上配置目录下的 `IndexedDB\` |
| 内嵌数据区 `<script id="adb-data">` | 只有**绑定文件后**才会写入 `index.html` 本体 |

所以"文件大小不变" = 还没绑定。设置 → 数据与同步 → **绑定 HTML 文件**（选中本 `index.html`）
→ 立即写入一次，之后每次记账约 0.5 秒后自动写回。验证方法：绑定后给文件大小/修改日期变化，
或用记事本打开搜 `adb-data`，能看到数据区的 base64 和 `<meta name="adb-saved-at">` 的最新时间戳。

**Q：金额为什么以「分」存储？**
A: 避免浮点累加误差（0.1+0.2 问题）；显示层再格式化为两位小数与千分位。

**Q：升级到新版时怎么保证数据不丢？**
A: 设置页「导出」→ 用新版 `index.html` 覆盖旧文件 → 新版里「导入」→ 一步恢复全部数据（含模块顺序、LOGO、外观）。详见"升级更新流程"。

**Q：点「添加」没有弹出安装确认？**
A: 以本地文件（file://）打开时浏览器禁止安装。用 `npx serve .` 起本地服务后访问，Chromium 系浏览器会显示「立即添加」；iOS 用 Safari 的「分享 → 添加到主屏幕」。应用会按平台自动给出对应指引弹层。

**Q：大类排序规则是什么？**
A: SQL 默认字符串序（Unicode 码点序），结果完全确定。如需拼音序，可在 `worker.js` 的 `getRecords`
排序键上扩展（例如为 category 增加拼音辅助列），属于预留扩展点。

---

## 十四、扩展指南

- **新增一个设置项**：`worker.js` 的 `DEFAULT_SETTINGS` 加键 → `app.js` 设置页加一行 UI → 完成（自动随库持久化）。
- **新增页面**：`Router.parse` 加分支 → 新增 `renderXxx()` → `render()` 分发。
- **给明细加字段**（如备注）：`SCHEMA_SQL` 加列 + 迁移语句 → 表单加输入 → `createRecord/updateRecord` 透传。
- **换/升级数据库引擎**：数据层全部收敛在 `worker.js` + `vendor/`，主程序只认 RPC 协议，可整体替换。

---

## 十五、许可证

MIT