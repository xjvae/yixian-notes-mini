; 一闲笔记 mini · tauri 自定义文案（简体中文）
; 由 bundle > windows > nsis > customLanguageFiles 引入，位置在所有 !insertmacro MUI_LANGUAGE 之后。
; 这里给全 27 条：模板里 $(deleteAppData) 一类的引用必须每条都有定义，缺一条 makensis 就断。
; 注意：本文件是原样 !include 的，不会被模板引擎渲染，所以产品名一律写 ${PRODUCTNAME}，
; 不能写 tauri 自带语言文件里的 {{product_name}} 占位符。

LangString addOrReinstall ${LANG_SIMPCHINESE} "添加/重新安装组件"
LangString alreadyInstalled ${LANG_SIMPCHINESE} "已安装"
LangString alreadyInstalledLong ${LANG_SIMPCHINESE} "${PRODUCTNAME} ${VERSION} 已经装在这台电脑上了。选一个操作，然后点下一步："
LangString appRunning ${LANG_SIMPCHINESE} "${PRODUCTNAME} 正在运行，安装会先关掉它；便签内容每 250 毫秒落一次库，不会丢。"
LangString appRunningOkKill ${LANG_SIMPCHINESE} "${PRODUCTNAME} 正在运行。$\n点确定就先关掉它再继续装。"
LangString chooseMaintenanceOption ${LANG_SIMPCHINESE} "选择要执行的维护操作。"
LangString choowHowToInstall ${LANG_SIMPCHINESE} "选择你想要安装 ${PRODUCTNAME} 的方式。"
LangString createDesktop ${LANG_SIMPCHINESE} "创建桌面快捷方式"
LangString dontUninstall ${LANG_SIMPCHINESE} "请勿卸载"
LangString dontUninstallDowngrade ${LANG_SIMPCHINESE} "请勿卸载（此安装程序禁止未卸载就进行版本降级的操作）"
LangString failedToKillApp ${LANG_SIMPCHINESE} "无法终止 ${PRODUCTNAME}。请手动关闭后再试。"
LangString installingWebview2 ${LANG_SIMPCHINESE} "正在安装 WebView2..."
LangString newerVersionInstalled ${LANG_SIMPCHINESE} "这台电脑上已经装了更新版本的 ${PRODUCTNAME}，不建议再装旧版本。确实要装旧的，建议先卸载当前版本。选一个操作，然后点下一步："
LangString older ${LANG_SIMPCHINESE} "旧的"
LangString olderOrUnknownVersionInstalled ${LANG_SIMPCHINESE} "系统中已存在版本为 $R4 的 ${PRODUCTNAME}，建议先卸载当前版本再装。选一个操作，然后点下一步："
LangString silentDowngrades ${LANG_SIMPCHINESE} "此安装程序禁止降级，静默安装无法进行，请改用图形界面。$\n"
LangString unableToUninstall ${LANG_SIMPCHINESE} "无法卸载！"
LangString uninstallApp ${LANG_SIMPCHINESE} "卸载 ${PRODUCTNAME}"
LangString uninstallBeforeInstalling ${LANG_SIMPCHINESE} "安装前卸载"
LangString unknown ${LANG_SIMPCHINESE} "未知"
LangString webview2AbortError ${LANG_SIMPCHINESE} "无法安装 WebView2，没有它这个应用跑不起来。请重试安装程序。"
LangString webview2DownloadError ${LANG_SIMPCHINESE} "错误：无法下载 WebView2 - $0"
LangString webview2DownloadSuccess ${LANG_SIMPCHINESE} "WebView2 引导程序下载成功"
LangString webview2Downloading ${LANG_SIMPCHINESE} "正在下载 WebView2 引导程序..."
LangString webview2InstallError ${LANG_SIMPCHINESE} "错误：安装 WebView2 时失败，错误代码：$1"
LangString webview2InstallSuccess ${LANG_SIMPCHINESE} "成功安装 WebView2"
LangString deleteAppData ${LANG_SIMPCHINESE} "同时删除我的便签数据（含快照，不可恢复）"

; 内页页眉那两行（标题 + 副标题）没有 MUI2 的 !define 入口，只能在这里重定义 MUI2
; 语言包自带的 LangString。本文件是在 !insertmacro MUI_LANGUAGE 之后 !include 的，
; 位置对；但"后定义覆盖前定义"这件事 NSIS 没写在文档里，所以改完必须装一次看页眉。
LangString MUI_TEXT_LICENSE_TITLE ${LANG_SIMPCHINESE} "许可协议"
LangString MUI_TEXT_LICENSE_SUBTITLE ${LANG_SIMPCHINESE} "安装前请过一眼"
LangString MUI_TEXT_DIRECTORY_TITLE ${LANG_SIMPCHINESE} "安装位置"
LangString MUI_TEXT_DIRECTORY_SUBTITLE ${LANG_SIMPCHINESE} "装在自己账户下，不动系统目录"
LangString MUI_TEXT_INSTALLING_TITLE ${LANG_SIMPCHINESE} "正在安装"
LangString MUI_TEXT_INSTALLING_SUBTITLE ${LANG_SIMPCHINESE} "${PRODUCTNAME} 正在装进这台电脑"
