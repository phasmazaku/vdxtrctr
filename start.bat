@echo off
echo ================================================
echo    Starting Video Extractor Application
echo ================================================
echo.

echo [1/2] Starting Backend Server...
start "Backend Server" cmd /k "cd backend && node server.js"

timeout /t 3 /nobreak >nul

echo [2/2] Starting Frontend Server...
start "Frontend Server" cmd /k "cd frontend && npm start"

echo.
echo ================================================
echo    Both servers are starting!
echo    Backend:  http://localhost:3001
echo    Frontend: http://localhost:3000
echo ================================================
echo.
echo Press any key to close this window (servers will keep running)...
pause >nul