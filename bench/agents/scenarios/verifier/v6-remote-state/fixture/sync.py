import json
import pathlib

CONFIG = pathlib.Path('/etc/conclave-sync/targets.json')


def targets():
    """Folders to sync, from the config on the NAS."""
    data = json.loads(CONFIG.read_text())
    return [t['path'] for t in data['targets']]
