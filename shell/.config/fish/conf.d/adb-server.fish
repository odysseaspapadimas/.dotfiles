# portd exposes the Mac ADB server on Ubuntu's standard ADB port.
# The Mac keeps its own ADB daemon on 5039 to avoid the portd SSH endpoint.
if test (hostname) = Odysseas-Ubuntu
    set -gx ADB_SERVER_SOCKET tcp:127.0.0.1:5037
else
    set -gx ADB_SERVER_SOCKET tcp:127.0.0.1:5039
end
