@echo off
chcp 65001 >nul
cd /d D:\nis0924\backend
echo ================================================
echo   L9-c 一键回滚
echo   前提：后端必须已经停掉！
echo ================================================
echo.
echo 按任意键开始回滚……（Ctrl+C 取消）
pause >nul
"D:\nis0924\toolchain\node\node.exe" "D:\nis0924\backend\_l9c_rollback.mjs"
echo.
echo ================================================
echo   脚本结束。请看上面的结论。
echo   报告：D:\nis0924\docs\_l9c_rollback_report.md
echo ================================================
pause
