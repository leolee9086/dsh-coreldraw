# dsh-coreldraw

DeepSeek Harness 的 CorelDRAW 自动化插件。JavaScript 注册工具并校验输入，C# 在专用 STA 线程中调用 CorelDRAW COM 对象。无需 Python、VBA 宏或额外的 CorelDRAW 插件。

## 安装

在 Harness 官方插件管理入口添加：

```text
github:leolee9086/dsh-coreldraw#main
```

包内的 `dsh.bundle.patch` 注册工具，不需要修改 agent 预设。安装后按 Harness 提示重新加载宿主。先调用 `corel_instances` 查看实例，使用返回的 `pid` 和 `instance_id` 调用 `corel_connect`，再用 `corel_documents` 验证文档。默认只附着已有实例；只有未发现现存实例时，`launch:true` 才允许启动软件。

发现同时读取 CorelDRAW 窗口和 COM 运行对象表。某些版本不注册 Application 活动对象，但会注册已打开的 CDR 文档；插件通过文档的明确 COM 接口找到所属应用，再核对窗口对应的进程。多个实例时需要显式选择，选择失败不会切换连接，实例切换会使旧文档 ID 失效。`instance_id` 包含进程创建时间，用于识别 PID 重用。

Windows 安全上下文会影响运行对象表的可见范围。例如，沙箱启动的测试实例和普通桌面实例可能互不可见。`connectable:false` 表示窗口存在，但当前进程不能取得其 COM 对象；诊断保留 HRESULT。应在实际 Harness 宿主中验收，而不是把独立沙箱脚本的发现结果当作宿主结果。未保存文档且 Application 未注册的实例也可能只能发现窗口；插件不会为取得连接而另开一份原文档。

## 系统与依赖

- Windows x64、.NET Framework 4.8、已安装且正常注册 COM 的 CorelDRAW。
- 固定依赖 `edge-js@26.1.0` 与 `electron-edge-js@44.0.0`，根据实际宿主选择其一，绝不把 Node 原生模块加载进 Electron。
- 本机桥接已实测 Node 22.19 / ABI 127、Harness Electron 44 / ABI 149。依赖包还带有 Node 20/24/26、Electron 39–43 的预编译产物，但这些运行时尚未逐个验收；项目要求 Node >=22.19。
- 安装允许 `--ignore-scripts`，不需要 node-gyp、Visual Studio Build Tools、.NET SDK 或 Electron rebuild。不要关闭 optional dependencies，否则桥接包会缺失。
- 原生二进制、VC 运行库以及 `edge-cs.dll`、`edge-cs-base.dll` 从本包的依赖范围解析，按内容哈希缓存。代码不依赖开发机目录，也不修改全局 `EDGE_NATIVE` / `EDGE_CS_NATIVE`。
- 编译器缓存需要可写的 ASCII 路径。默认尝试临时目录及 ProgramData；中文用户名且默认目录不可写时，可将 `CORELDRAW_CACHE_DIR` 或插件 `cacheDir` 配置为一个自己可写的 ASCII 目录。错误会明确指出需要设置的位置。

## 工具

| 工具 | 功能 |
| --- | --- |
| `corel_instances` | 发现实例，返回 PID、实例标识、窗口标题、可连接状态及诊断 |
| `corel_connect` | 按 PID 和实例标识连接；可指定活动对象探针的 ProgID |
| `corel_documents` | 列出文档，取得绑定实际 COM 文档的 ID |
| `corel_create` | 新建指定毫米尺寸的空白文档 |
| `corel_shapes` | 分页读取一层对象的 ID、范围和可选文字；按 children_path 展开组 |
| `corel_inspect` | 读取当前页、图形、文字及编辑令牌；大图应先用 corel_shapes |
| `corel_apply` | 批量创建矩形、椭圆、段落文字；移动、缩放、旋转、填色、改字、删除 |
| `corel_undo` | 撤销指定文档最近一条命令 |
| `corel_save` | 保存到明确的 `.cdr` 路径 |
| `corel_export` | 导出 PNG、SVG 或 PDF；可按选中对象或指定矩形范围导出 PNG |
| `corel_export_catalogue` | 将一页的顶层对象和嵌套组写成 JSON 目录，返回数量、尺寸和文件位置 |
| `corel_export_assets` | 按对象 ID 批量导出透明 PNG、SVG，以及毫米坐标索引；支持预检和 PNG 裁切 |

浏览、编辑、目录和批量切图坐标都是页面左上角起算的毫米；`corel_export.area` 使用页面左下角，换算见下文。文字字号是点。`corel_apply` 和 `corel_undo` 要带最近一次检查返回的 `expected_revision` 和 `snapshot_token`。一个批次最多100项，检查最多5000个图形，支持组内递归。保存及导出使用绝对路径，覆盖已有文件需要 `overwrite:true`。

```json
{
  "document_id": "从检查结果复制",
  "expected_revision": 0,
  "snapshot_token": "从检查结果复制",
  "label": "创建示例矩形",
  "operations": [
    { "op": "rectangle", "x": 10, "y": 10, "width": 30, "height": 20, "rgb": [35, 120, 210] }
  ]
}
```

默认观察及控制均通过 Harness 审批。配置 `observeApproval` / `controlApproval` 接受 `ask`、`allow`、`deny`；正式 Full access 权限预设可免除 `ask`，显式 `deny` 始终有效。普通调用的 `timeoutMs` 默认60000，范围1000..300000；目录和批量切图使用独立的 `exportTimeoutMs`，默认600000，范围1000..600000。等待超时不等于Corel已经停止执行。

### 大图的对象定位

`corel_shapes({document_id, limit:50})` 默认只读顶层，不递归扫描整页。跟随 `next_offset` 继续，后续请求传回同一 `page`；组对象的 `children_path` 可原样传作 `path`，只展开该组。每批最多100项，约5秒后在对象之间停止并返回下一偏移。单个COM调用仍不可中止，因此预算不是硬超时。坐标包含页面外对象，统一转换为毫米，不改文档单位或参考点。`include_text:true` 读取文字对象最多4000字符，文字已转曲时仅有曲线对象。

分页结果来自实时文档，不是原子快照；人工增删或重排后应重新浏览。组路径同时核对索引和StaticID，错位时拒绝。分页结果不提供编辑令牌。完整 `corel_inspect` 在对象之间检查10秒预算，超出后明确建议分页，恢复原单位并且不签发令牌；因此大型文档的整页编辑令牌仍可能无法取得，不能用分页结果替代编辑校验。

### 完整对象目录

`corel_export_catalogue({document_id, path: "C:\\project\\catalogue.json"})` 把指定页（默认活动页）的目录写到文件，避免上千对象挤进工具回复。行字段包括 `index/id/type/name/x/y/w/h/fill_type`，纯色填充才有 `fill_hex`，组的子对象位于 `children`。读取填充失败会记录 `fill_error`；`include_text:true` 可读取未转曲文字，最多4000字符。

默认最多100000个对象，可用 `max_shapes` 调整到1000000；嵌套超过32层或总数超限会明确失败，保留已有目录。目录先写入同目录临时文件，再整体替换；已有目标需要 `overwrite:true`。读取过程按比例转换毫米，不修改文档单位、选区或活动页。

该目录是实时读取，不是编辑快照。它遍历普通组，**不展开 PowerClip 内部对象**；导出 PowerClip 里的图片时可选它的容器。转曲文字只能读到曲线，插件不会自动恢复文本或判断标题、图片、底图的语义，需结合预览确定对象集合。

### 导出范围

`corel_export` 有三种范围：

- 默认导出当前页的整体内容。
- `selection: true`（PNG、SVG）导出 CorelDRAW 里**当前选中对象**的外接范围。选择属于界面会话：在 CorelDRAW 里选好对象再调用；若一个对象也没选，插件会直接报错说明，而不是导出一个来路不明的区域（CorelDRAW 自己对空选区只会返回 `E_FAIL`）。返回的 `selected_objects` 是本次实际选中的对象数。
- `area: {x, y, width, height}`（仅 PNG）导出任意矩形，单位毫米，原点在**页面左下角**，因此可以直接用 `corel_shapes` 读到的毫米坐标（把它的页面左上角 y 换算成 `页面高度 - y - 高`）。实测 `0,0,100,80` 在 100x80mm 页面上得到 377x302 像素。

`dpi` 默认 96，可选 24..1200；面积导出靠它放大像素，选区导出也靠它，否则 CorelDRAW 会按自己的 300dpi 默认值输出大图。导出会临时将文档单位和参考点切到毫米，结束后恢复，不写入任何文档内容。选区范围由 CorelDRAW 的实时选择决定，与 `corel_shapes` 的分页快照可能瞬时不一致。

### 按对象批量切图

`corel_export_assets` 接收 `document_id`、`output_dir` 和1至100个 `assets`。每个素材提供有意义的相对 `name`、递归图元 `shape_ids`、`formats: ["png", "svg"]`，PNG可指定 `dpi`。先用 `dry_run:true` 校验整批对象、目标冲突与实际边界，再正式导出。选区不接受父组与其子对象同时入选。

PNG默认透明，完整包含描边；`crop` 使用页面左上角毫米，且只用于PNG。SVG保留完整选区及Corel原填充，位图资源可能由Corel放在相邻资源目录中。`origin` 只用于返回相对坐标，不移动原稿。结果分别记录原对象几何、含描边范围、实际PNG裁切范围，避免把SVG与PNG的不同画布混用。

`report_path` 指定JSON进度文件，首次输出前写入未完成状态，每个文件导出后整体更新；失败时先核对记录与已有文件，再提交剩余项。默认拒绝覆盖，只有 `overwrite:true` 才允许替换。JSON目录与进度文件使用同目录临时文件发布；PNG/SVG仍由Corel直接写入，失败或中断可能留下部分产物。工具逐项尝试恢复原选区、页、单位和活动文档，恢复失败会明确报错；不保存或复制原稿。一次COM调用不可中止，超时后不要盲目重跑。

PNG的 `dpi` 范围为12..1200，默认96。`dry_run` 验证对象、边界和参数，不检查语义是否完整；正式返回的 `complete:true` 表示批次导出完成，仍需看图检查遗漏、透明区域、SVG里的位图引用与字腔。SVG保持Corel的填充关系，不做自动封孔或重画。

独立CLI复用同一个桥动作与参数校验：

```powershell
node scripts/export-assets.mjs C:\\project\\assets.json --dry-run
node scripts/export-assets.mjs C:\\project\\assets.json
```

CLI配置用 `document_path` 指定已经打开的原稿，替代会话内的 `document_id`；可提供 `connection: {pid, instance_id}` 选择实例，其余字段与工具相同。项目配置、进度和产物应存放在该项目目录，插件仓库只存放通用实现及通用验证。

## 行为限制

批次使用 CorelDRAW 撤销组，异常时尝试回滚，不能承诺数据库式原子性。COM 调用一旦发出无法可靠取消；超时或取消返回结果未知时，原任务可能继续完成，后续请求仍串行等待，绝不自动重试写操作。应先检查文档再决定下一步。

快照令牌覆盖当前页读回的几何、文字及部分填充属性，不能检测所有字体、轮廓、PowerClip或其他页面的人工变化。执行期间请避免手工同时编辑。`corel_undo` 撤销的是该文档最新命令，可能包含人工操作，并非按插件历史定向回滚。PDF 使用文档现有发布设置；当前不提供印前配置管理。断开桥接不会主动调用 CorelDRAW 的 `Quit()`。

## 开发与验证

```powershell
pnpm install --ignore-scripts
pnpm test
pnpm doctor
pnpm smoke:discovery
pnpm smoke:corel
```

`doctor` 不连接 CorelDRAW，验证编译、STA串行、依赖文件及环境变量隔离。`smoke:corel` 明确启动或连接 CorelDRAW，新建独立测试文档，验证中文文字、几何、令牌冲突、撤销及CDR/PNG/SVG/PDF输出；测试文档保留在软件中，文件写入 `artifacts/` 下的新目录。

`pnpm smoke:assets C:\project\smoke-config.json` 使用与切图CLI相同的配置，要求新的 `output_dir` 和明确的已打开原稿路径。它验证目录覆盖拒绝、超限时保留旧目录、目录整体替换、预检不写文件、真实PNG/SVG导出、PNG含透明通道、重复输出拒绝，以及导出前后图元目录一致；不保存、关闭或复制原稿。配置中的对象ID和输出位置属于项目，测试脚本没有预置项目数据。

`smoke:discovery` 对已打开文档做只读检查，验证多实例选择、失效实例标识拒绝、失败选择后原连接仍有效以及发现过程没有启动新实例。可用 `CORELDRAW_TEST_PID` 指定目标，`CORELDRAW_DISCOVERY_REPORT` 保存结果。`pnpm instances` 输出当前执行环境的发现诊断。

使用真实 Electron 而非普通 Node 替代测试：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
Start-Process -Wait -FilePath 'C:\path\to\DeepSeek Harness.exe' `
  -ArgumentList @('C:\path\to\dsh-coreldraw\scripts\doctor.mjs') `
  -RedirectStandardOutput '.\electron-stdout.log' `
  -RedirectStandardError '.\electron-stderr.log'
```

必须看到 `DSH_CORELDRAW_DOCTOR_COMPLETE`；只看 GUI 可执行文件退出码不足以证明成功。可设置 `CORELDRAW_DOCTOR_REPORT` 为唯一输出路径，完成后写入含实际运行时的 JSON 凭证。

设计参考：[dsh-computer-use](https://github.com/leolee9086/dsh-computer-use) 的运行时分流及配套编译器文件处理；[corel-mcp](https://github.com/CubicDev1/corel-mcp) 的 COM 接入思路。本插件独立实现，CorelDRAW版本差异以真实读回为准。
