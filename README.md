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
| `corel_inspect` | 读取当前页、图形、文字及编辑令牌 |
| `corel_apply` | 批量创建矩形、椭圆、段落文字；移动、缩放、旋转、填色、改字、删除 |
| `corel_undo` | 撤销指定文档最近一条命令 |
| `corel_save` | 保存到明确的 `.cdr` 路径 |
| `corel_export` | 导出 PNG、SVG 或 PDF |

操作坐标是页面左上角起算的毫米，文字字号是点。`corel_apply` 和 `corel_undo` 要带最近一次检查返回的 `expected_revision` 和 `snapshot_token`。一个批次最多100项，检查最多5000个图形，支持组内递归。保存及导出使用绝对路径，覆盖已有文件需要 `overwrite:true`。

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

默认观察及控制均通过 Harness 审批。配置 `observeApproval` / `controlApproval` 接受 `ask`、`allow`、`deny`；正式 Full access 权限预设可免除 `ask`，显式 `deny` 始终有效。

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
