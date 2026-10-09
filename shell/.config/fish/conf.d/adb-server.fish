# Preserve machine-local overrides. Omarchy owns the ADB server on5039;
# development hosts use its portd reverse forward on5037.
if not set -q ADB_SERVER_SOCKET
    if test (hostname) = Omarchy-Mac
        set -gx ADB_SERVER_SOCKET tcp:127.0.0.1:5039
    else
        set -gx ADB_SERVER_SOCKET tcp:127.0.0.1:5037
    end
end
