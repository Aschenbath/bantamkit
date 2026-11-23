"""Report the reference process's test sandbox without overriding its environment."""

import json
import os
from pathlib import Path

print(json.dumps([str(Path.home()), os.environ.get("HOME"),
                  os.environ.get("USERPROFILE"), os.environ.get("BANTAMKIT_INDEX_DIR")]))
