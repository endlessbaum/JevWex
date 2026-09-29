"""JEVWEX_TOKENを設定し python examples/server/evaluate.py [画像パス]"""
import base64
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

payload = {"state": "The cat sleeps on a sofa.", "questions": {"animal": {
    "type": "choice", "instructions": "Identify the animal.",
    "criteria": {"cat": "A cat", "dog": "A dog", "other": "Other or no animal"}
}}}
if len(sys.argv) > 1:
    path = pathlib.Path(sys.argv[1])
    payload["state"] = "Identify the animal in the image."
    payload["images"] = [{"name": path.name, "mime_type": "image/png" if path.suffix.lower() == ".png" else "image/jpeg",
                          "data_base64": base64.b64encode(path.read_bytes()).decode("ascii")}]
request = urllib.request.Request(
    "http://127.0.0.1:{}/api/v1/evaluate".format(os.environ.get("JEVWEX_PORT", "39281")),
    data=json.dumps(payload).encode("utf-8"),
    headers={"Authorization": "Bearer " + os.environ["JEVWEX_TOKEN"], "Content-Type": "application/json"}, method="POST")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(request, timeout=310) as response:
        print(json.dumps(json.load(response), ensure_ascii=False, indent=2))
except urllib.error.HTTPError as error:
    print(error.read().decode("utf-8"), file=sys.stderr)
    sys.exit(1)
