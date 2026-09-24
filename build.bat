@echo off
rem ===========================================================================
rem  深大选课辅助工具 - 双击打包脚本（PyInstaller）
rem
rem  用法：直接双击本文件即可。
rem  产物：build\szu_bkxk\szu_bkxk.exe（整个 build\szu_bkxk 目录都要保留）
rem
rem  说明：
rem    - 本脚本只做打包，**不会**运行程序、不会访问学校站点；
rem    - WebView2 SDK（vendor\webview2）会一并打进包里；
rem    - 需要先按 README 建好 .venv 并安装依赖。
rem ===========================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   深大选课辅助工具 - 打包
echo ============================================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [错误] 未找到虚拟环境 .venv\Scripts\python.exe
    echo        请先按 README 的「三、安装」创建虚拟环境并安装依赖。
    echo.
    pause
    exit /b 1
)

if not exist "vendor\webview2\lib\net462\Microsoft.Web.WebView2.Core.dll" (
    echo [警告] 未找到 WebView2 SDK：vendor\webview2\lib\net462\
    echo        仍会继续打包，但程序启动后「选课网页」标签页会提示不可用并降级为纯 aiohttp 模式。
    echo.
)

echo [1/3] 检查 PyInstaller ...
".venv\Scripts\python.exe" -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
    echo       未安装，正在安装（仅首次需要）...
    ".venv\Scripts\python.exe" -m pip install pyinstaller
    if errorlevel 1 (
        echo [错误] PyInstaller 安装失败，请检查网络或手动执行：
        echo        .venv\Scripts\python.exe -m pip install pyinstaller
        echo.
        pause
        exit /b 1
    )
)

echo [2/3] 清理旧产物 ...
if exist "build" rmdir /s /q "build"
if exist "build\szu_bkxk" rmdir /s /q "build\szu_bkxk"

echo [3/3] 开始打包（约 1-3 分钟，请勿关闭窗口）...
".venv\Scripts\python.exe" -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --windowed ^
  --name szu_bkxk ^
  --distpath build ^
  --workpath build\_work ^
  --add-data "vendor\webview2;vendor\webview2" ^
  --collect-all pythonnet ^
  --collect-all clr_loader ^
  --hidden-import clr ^
  main.py

if errorlevel 1 (
    echo.
    echo [错误] 打包失败。若提示缺少 clr / Python.Runtime，请改用下面的「排错版」命令：
    echo        .venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --console ^
    echo          --name szu_bkxk --distpath build --add-data "vendor\webview2;vendor\webview2" ^
    echo          --collect-all pythonnet --collect-all clr_loader ^
    echo          --hidden-import clr --debug imports main.py
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   打包完成
echo   可执行文件：build\szu_bkxk\szu_bkxk.exe（双击运行）
echo   注意：整个 build\szu_bkxk 目录都要保留，不能只拷贝 exe
echo ============================================================
echo.
pause
