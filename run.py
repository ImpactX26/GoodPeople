"""Start the LUNA NGO Matching Agent server.

    python run.py                 -> http://127.0.0.1:8000
    python run.py --port 9000
    HOST=:: PORT=8080 python run.py   (Railway sets PORT)
"""
import argparse
import os

import uvicorn

from luna_ngo.api import create_app

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    a = ap.parse_args()
    print(f"\n  🌙 LUNA NGO Matching Agent → http://{a.host}:{a.port}\n  NGO portal → http://{a.host}:{a.port}/portal\n")
    uvicorn.run(create_app(), host=a.host, port=a.port, log_level="warning")
