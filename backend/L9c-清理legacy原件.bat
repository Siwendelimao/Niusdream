@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
echo ================================================
echo   L9-c legacy 原件清理（手动入口）
echo ================================================
echo.
echo  说明：
echo    迁移到 append-only 后，890 个原 .json 在
echo    sessions.trash\legacy\ 里作回滚保险（787MB）。
echo.
echo    计划任务「NIS-L9c-清理legacy原件」会在
echo    2026-11-16 03:00 自动跑一次。
echo.
echo    如果那时电脑没开机、或你想提前清理，
echo    双击本文件即可（也可以先 dry-run 看一眼）。
echo.
echo  安全自检（任一不满足就不删）：
echo    1. sessions\ 新格式目录 ^>= 800 个
echo    2. sessions\ 根没有残留 .json
echo    3. legacy 里每个文件都有对应的新格式会话
echo.
echo ------------------------------------------------
echo  [1] 只检查不删（dry-run）
echo  [2] 真删（787MB）
echo  [3] 查看计划任务状态
echo  [4] 取消计划任务（以后不自动删）
echo ------------------------------------------------
set /p choice=请输入 1/2/3/4 然后回车：
if "%choice%"=="1" goto dry
if "%choice%"=="2" goto real
if "%choice%"=="3" goto query
if "%choice%"=="4" goto cancel
echo 无效输入，退出。
pause
exit /b 1

:dry
echo.
"D:\nis0924\toolchain\node\node.exe" "D:\nis0924\backend\_l9c_cleanup_legacy.mjs" --dry-run
goto end

:real
echo.
echo 确认要真删这 787MB 吗？如果最近没出问题、也确认不打算回滚，就删。
set /p sure=输入 YES 确认：
if /i not "%sure%"=="YES" (echo 已取消。& goto end)
"D:\nis0924\toolchain\node\node.exe" "D:\nis0924\backend\_l9c_cleanup_legacy.mjs"
goto end

:query
schtasks /Query /TN "NIS-L9c-清理legacy原件" /FO LIST /V | findstr /i "任务名 下次运行 登录状态 计划任务状态"
goto end

:cancel
schtasks /Delete /TN "NIS-L9c-清理legacy原件" /F
echo 计划任务已取消（legacy 文件仍在，可随时手动清）。
goto end

:end
echo.
echo 日志：D:\nis0924\backend\data\logs\_l9c_legacy_cleanup.log
pause
