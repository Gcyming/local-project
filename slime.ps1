# slime 一体化启动器:起 server → 进 CLI → 退出时杀 server
# 所有进程管理逻辑在 slime_launcher.py 里,绕开 shell 兼容问题
$python = "C:\Users\MR\AppData\Local\Programs\Python\Python312\python.exe"
if (-not (Test-Path $python)) { $python = "python" }
& $python "D:\tool\slime\slime_launcher.py" $args
