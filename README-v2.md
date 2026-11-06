# PaperForge v2.3 Beta — GitHub Pages + Supabase

目前环境：**不用 VPS**；静态网站继续放在 GitHub Pages；Google 登录、会员状态、免费次数和管理员审批记录交由 Supabase 托管。收款使用管理员自己的 QR Code，管理员收到钱后手动审批。

网站：<https://junhao87.github.io/paperforge/>

管理员 Google 邮箱：`junhaochong5@gmail.com`

## 功能与计费规则

| 账户状态 | 导出权限 |
| --- | --- |
| 未登录 | 先使用 Google 登录 |
| 免费注册用户 | **所有导出类型总共 1 次**：编辑后 PDF、PDF 转 Word、Word 转 PDF 任选其一 |
| Premium（RM10 / 30 天） | 有效期内不限次数导出 |
| Complimentary（管理员赠送） | 不限次数，直到管理员撤销 |
| Suspended | 不能导出 |
| Admin | 不限次数，可处理付款申请、赠送或撤销权限 |

“成功导出”在这个浏览器版本中定义为：**转换文件已生成、Supabase 配额授权成功、浏览器已触发下载动作**。网站不能获知用户最终是否保存了文件，因此如果浏览器拦截下载，配额仍可能已计入。

## 1. 建立 Supabase 项目

1. 到 <https://supabase.com/dashboard> 建立一个项目（名称可以是 `paperforge`）。
2. 打开 **SQL Editor**，执行本项目 `supabase/schema.sql` 的全部内容。它会建立会员、付款申请、导出事件和管理员审计表，并启用 Row Level Security（RLS）。
3. Project URL 和浏览器可公开使用的 Publishable key 已由管理员提供，并已写入 `dist/config.js`：

   ```js
   supabaseUrl: 'https://ngsriedtuisaothoqhlk.supabase.co',
   // Publishable Key 已配置，可在 dist/config.js 中查看。
   ```

4. 不需要再次修改项目 URL 或 Publishable key。**但数据库的 schema.sql 仍需在 Supabase SQL Editor 手动执行**。

**绝对不要把** `service_role`、`sb_secret_...`、数据库密码或 Google OAuth Client Secret **写进 GitHub 或 config.js**。Publishable/anon key 本来就用于公开前端，但依然必须使用 RLS。

## 2. 设置 Google 登录

1. 在 Supabase 打开 **Authentication → Providers → Google**，启用 Google。
2. 使用 Google Cloud Console 创建 OAuth Client ID（Web application），并配置授权同意页面。
3. 在 Google Cloud 的 **Authorized redirect URIs** 中填入 Supabase 显示的回调 URL，通常是：

   `https://ngsriedtuisaothoqhlk.supabase.co/auth/v1/callback`

4. 把 Google OAuth **Client ID 和 Client Secret 只填写到 Supabase Google Provider 的服务器端配置页面**，不要放到静态网站代码里。
5. 在 Supabase **Authentication → URL Configuration**：
   - **Site URL**：`https://junhao87.github.io/paperforge/`
   - **Redirect URLs** 新增：`https://junhao87.github.io/paperforge/`
6. 保存后登录网站，点击 **Google 登录** 测试。

参考：<https://supabase.com/docs/guides/auth/social-sign-in/auth-google> 和 <https://supabase.com/docs/guides/auth/redirect-urls>。

## 3. 指定管理员（必须手动执行）

先使用 `junhaochong5@gmail.com` 在新网站完成 **第一次 Google 登录**，等待 `pf_profiles` 自动创建记录。

然后在 Supabase SQL Editor 执行：

```sql
update public.pf_profiles
set role = 'admin', plan = 'complimentary'
where lower(email) = 'junhaochong5@gmail.com';
```

检查 SQL 返回的已更新行数是否为 1。刷新网页后，右上角应出现 **Admin**。用户名/邮件前端文字不能自行提升为管理员：实际访问权限由数据库角色和 SQL 函数决定。

## 4. 收款 QR Code（已配置）

已使用管理员提供的 Touch 'n Go eWallet / DuitNow QR 图片，收款人显示为 **CHONG JUN HAO**：

1. 图片：`dist/assets/duitnow-qr.png`。
2. `dist/config.js` 已设置 `paymentQrImage: './assets/duitnow-qr.png'`。
3. 更新 GitHub Pages 时需把整个 `assets/` 目录一起上传。付款页展示原始 QR 图片，可在手机上放大扫描。

付费流程：用户点击「我的会员」→ 扫你的二维码汇款 RM10 → 页面自动显示当前**登录 Gmail**（无需填写付款参考号或姓名）→ 用户提交付款通知 → 你本人独立核实到账 → 点击 Admin → Approve → 给该用户延长 30 天 Premium。**用户点击“我已付款”并不会自动获得权限**；仅 Gmail 不能作为到账凭证，管理员必须对照银行/钱包的实际交易记录。

你也可以在 Admin 用户列表按「免费批准」送出不限次数权限；「撤销」回到试用状态；「暂停」禁止导出。

## 5. 发布到已有 GitHub Pages

**注意：`dist/` 的内容需要放在 GitHub 仓库的发布根目录。** 不要把整个 `dist` 文件夹当作唯一网站文件夹上传，否则 `https://junhao87.github.io/paperforge/` 无法找到根目录的 `index.html`。

在 `paperforge` 仓库根目录，保留 `.git`，更新：

- `index.html`
- `app.js`、`styles.css`、`upgrade.css`
- **新增** `config.js`、`membership.js`、`membership.css`
- `vendor/`（保留现有 PDF.js / PDF-LIB / DOCX / JSZip 依赖）
- 新增 `assets/duitnow-qr.png`

然后 GitHub Desktop 里：**Commit to main → Push origin**。

GitHub 网页 `Repository → Settings → Pages` 保持：**Deploy from a branch → main → /(root)**。等待 Actions/Pages 发布后刷新网站。

如果想同时把后端数据库版本管理，建议再把本项目的 `supabase/schema.sql` 放到仓库的 `supabase/` 目录；这不会被网页自动执行，只供管理员手动安装。

## 6. 高保真 PDF 与 OCR 的实际能力

- 读取 PDF.js 文字层信息、字高、字体族和字体样式，在可用时复用 PDF.js 已加载的字体进行 **浏览器预览和画布绘制**。
- 从已渲染 PDF 页面局部像素估计字色和底色；支持中英文文字替换、字号、粗体、斜体和拖动位置。
- PDF 导出时目前采用 **遮盖原字 + 把新字绘制为图片叠加在 PDF 上**；原有页面大部分绘图内容保留，但**旧文字并未从 PDF 的底层内容流删除**，因此它可能仍可被文字提取工具搜索到。
- 替换文字被栅格化为图片，**不能保证新字仍然可选择、搜索或以原嵌入字体形式保留**。不等同于 Adobe Acrobat 的真实内容流编辑。
- **OCR v2.3**：独立高分辨率 PDF 图像识别，显式请求 Tesseract 的 TSV / block / hOCR 位置；普通识别无结果时，自动增强对比度并改用稀疏文字模式重试。如果 PDF 已有可提取的原文字，还会尝试用原文字的坐标创建可点击编辑区域。首次需从 CDN 下载中英模型；识别依然有漏字、错字或错位风险。如因 CDN、浏览器内存或扫描品质导致失败，请直接使用「框选改字」。
- **无需 OCR 的框选改字**：点击「框选改字」，按住鼠标或手指框住旧文字，在属性栏填写替换内容并点「应用修改」。即使 Tesseract 网络不可用，也可以遮盖旧扫描文字并添加新字。复杂背景、手写体、表格线可能留下遮盖痕迹，并不是原生文字层编辑。
- **OCR 选区**：如果「OCR 本页」仍无法识别，先点击「框选改字」拖出一个较小的文字区域，再点「OCR 选区」。系统针对该区域尝试单块识别，若没有文字则增强对比度后按单行识别；识别结果会写进右侧编辑框，校对后点「应用修改」。此功能不需要整页 OCR 成功。
- **独立签名**：点击「手写签名」，用鼠标、手指或触控笔签字，选择「手动点位置」或「直接放到本页」。无需 OCR；可以拖动或调整大小。此功能是**透明 PNG 视觉签名**，不提供基于证书的数字签名。
- **手机与 iPad**：新增自适应页宽、可触控框选、签名板、移动签名和移动版工具栏；手机属性栏会放到页面下方，可向下滚动编辑。请在实际设备和浏览器上再次验收。
- **PDF→Word** 提供两种模式。**原貌保真**把 PDF 每页渲染为图像并加入 Word，视觉最接近原版，但不可直接修改文字。**固定版式可编辑**保留原 PDF 页面的图形和表格背景，在背景上移除可提取的旧文字，再把文字以 Word 原生固定坐标文字框重新放回，避免旧版普通段落重排导致整页跑位。文字框可以修改，但改长后不能自动重排后续内容；背景颜色、特殊字体、扫描页和复杂排版可能留有误差。混合文档中的扫描页仍以图片保留；如果整份 PDF 都是图片，没有原文字层，就会提示改用原貌保真或 PDF 编辑器的 OCR。仍然无法承诺复杂文件 100% 同版且可编辑。
- **Word→PDF（未达到零偏差）** 仍使用 `docx-preview` 和 `html2canvas`。`docx-preview` 不会完整重算 Word 的自动分页，浏览器无法保证 Word 原生版式 100% 不变：没有明确分页标记的 DOCX 可能在段落中间截断，特殊字体会替换，导出 PDF 文字可能无法复制。**如果你要求合同一字不移位，请在安装原字体的 Microsoft Word 中原生另存为 PDF**；不使用服务器的浏览器版本暂时不能承诺这项要求。
- 图章、扫描背景、复杂图层、特殊字体、文字旋转、表格/多栏等可能有明显误差。

## 7. 重要安全提示（上线收费前阅读）

这是 **Beta 原型，不是可安全商业收费的强制付费墙**：GitHub Pages 会公开发送网页 JavaScript 和 PDF 处理逻辑。Supabase RLS 能阻止普通用户自行修改数据库会员权限、次数和付款状态，但技术用户可能复制浏览器处理代码，绕过导出按钮与限制。因此建议在正式对外收款前，将 PDF **实际导出** 移至受保护的后端（VPS、Edge Function、其他可信服务），在后端验证授权后再返回文件。

另请留意：用户原 PDF 在本地浏览器渲染；从 URL 打开 PDF 会由浏览器请求提供该 URL 的服务器；Google 身份和支付申请信息会保存在 Supabase；OCR 与增强 Word 转换首次加载第三方 CDN 库/语言模型。不要对外宣称所有数据都绝不离开设备。

## 8. 建议验收清单

- [ ] 未登录时打开文件会看到 Google 登录窗口
- [ ] 用新 Google 用户登录，出现 1 / 1 免费导出
- [ ] 选择任一功能导出 1 次后变为 0 / 1；下次导出看到 Premium 提示
- [ ] 不同浏览器登录同一账号，免费次数仍然是 0 / 1
- [ ] 管理员登录后可以查看付款申请、批准/拒绝
- [ ] 管理员免费批准一个用户后，该账号能不限次数导出
- [ ] 管理员撤销或暂停后，数据库立即拒绝后续导出
- [ ] OCR 扫描 PDF 页面可识别中文和英文并替换一处文字
- [ ] 即使 OCR 失败，也能框选文字、修改并导出
- [ ] 即使没有文字层，也能签名并保存 PDF
- [ ] 在 Android / iPhone / iPad 上测试工具栏、触控框选、签名与浏览器下载
- [ ] 用同一原始 DOCX/PDF 逐页比较可编辑与保真模式（复杂布局保真仅保证视觉优先）
- [ ] 导出 PDF 与原件视觉对比，包括字体、字号、颜色、位置

**Google 登录排查**：新版加入 Supabase JavaScript SDK 的 CDN 备用来源、超时处理和重试连接按钮，登录弹窗会在连接完成后自动刷新。若另一个 Gmail 仍无法登录，检查 Google Auth Platform → Audience 的 External/Testing 状态、测试用户列表，以及 Supabase URL Configuration。Google OAuth Console 如只允许测试用户，需批准该 Gmail 或按你的上架计划发布应用。

**上线状态**：此下载包不会自动替换 GitHub Pages；请将 ZIP 内网站文件更新到仓库根目录，Commit → Push 后测试。用户此前已完成的 Supabase schema、Google OAuth 与管理员设置无需重复执行。
