import json
from pathlib import Path

cpus = []
for line in Path('/proc/stat').read_text().splitlines():
    fields = line.split()
    if fields and fields[0].startswith('cpu'):
        ticks = list(map(int, fields[1:9]))  # Exclude guest time (already included).
        cpus.append({'name': fields[0], 'total': sum(ticks), 'idle': ticks[3] + ticks[4]})
memory = {}
for line in Path('/proc/meminfo').read_text().splitlines():
    key, value = line.split(':', 1)
    memory[key] = int(value.split()[0])
print(json.dumps({'cpus': cpus, 'memory': memory,
                  'load': Path('/proc/loadavg').read_text().split()[:3],
                  'uptime': float(Path('/proc/uptime').read_text().split()[0])}))
