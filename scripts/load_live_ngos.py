"""Load real NGO records into the LIVE database.

    python scripts/load_live_ngos.py data/ngos_live_template.json

Every record is validated against the NGO schema. LIVE mode refuses
synthetic data (data_source must be "LIVE", reliability.source must not be
"synthetic"). Invalid records are reported and skipped.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from luna_ngo.config import get_config  # noqa: E402
from luna_ngo.service import LunaService  # noqa: E402


def main(path: str) -> None:
    svc = LunaService(get_config())
    records = json.loads(Path(path).read_text(encoding="utf-8"))
    ok, bad = 0, 0
    for rec in records:
        try:
            svc.upsert_ngo("LIVE", rec)
            ok += 1
        except Exception as e:  # report and continue
            bad += 1
            print(f"  ✗ {rec.get('ngo_id', '?')}: {e}")
    print(f"Loaded {ok} NGO(s) into LIVE database; {bad} rejected.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
