; 一闲笔记 mini · NSIS 文案覆盖
; 由 bundle > windows > nsis > installerHooks 引入，位置在模板顶部（MUI2.nsh 之后、各页宏之前），
; 所以这里 !define 的页面文案会被后面每一个 MUI_PAGE_* 宏读到。
; 只放 !define：四个安装页 + 一个卸载确认页的标题与正文。按钮沿用 NSIS 中文语言包的"上一步/下一步/完成"。

; 页头图默认画在左上，MUI2 只有 MUI_HEADERIMAGE_RIGHT 这一个开关，且它是全局的
; （Interface.nsh 里 !ifdef MUI_HEADERIMAGE_RIGHT，从不 !undef），在这里定义一次六个页都走右上。
!define MUI_HEADERIMAGE_RIGHT

; 1. 欢迎页
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 一闲笔记 mini"
!define MUI_WELCOMEPAGE_TEXT "装到你自己的账户下，不需要管理员权限，也不弹授权框。$\r$\n$\r$\n正在运行的旧版本会被先关掉再覆盖。便签内容每 250 毫秒落一次库，不会丢你正在打的字。"

; 2. 许可协议页（正文来自 bundle > licenseFile 指向的中文译文）
!define MUI_LICENSEPAGE_TEXT_TOP "安装前请读一遍下面的许可协议，然后选择同意。"
; NSIS 自带那句写的是"[我同意(I)]"，可按钮其实叫"我接受(I)"，这里对齐它
!define MUI_LICENSEPAGE_TEXT_BOTTOM "接受上面的条款才能继续；不接受就点取消，这台电脑上什么都不装。"

; 4. 安装位置页
!define MUI_DIRECTORYPAGE_TEXT_TOP "程序将安装到这个文件夹："
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "安装位置"

; 6. 完成页
!define MUI_FINISHPAGE_TITLE "装好了"
!define MUI_FINISHPAGE_TEXT "第一次启动会演一遍十二步引导：长按右键唤星环、新建便签、私密层与备份。不想看，引导窗右上角随时关。"

; 卸载确认页
!define MUI_UNCONFIRMPAGE_TEXT_TOP "要移除一闲笔记 mini 吗？"
!define MUI_UNCONFIRMPAGE_TEXT_LOCATION "便签数据不在安装目录里，它在 %APPDATA% 下，只有下面那个勾选才会动它："
