"""Pinger buffer tests (grant gr_rcj8nkbkbt, kr_nrh9ygog2w): python3 -m unittest discover -s deploy/pinger"""
import tempfile
import unittest
from pathlib import Path

import muster_pinger as mp


class Quiet(mp.Sender):
    def __init__(self):
        super().__init__({}, dry_run=True)
        self.sent = []

    def send(self, sms, subject, body):
        self.sent.append(subject)


class Town:
    """A fake /api/uptime/probes: down while `up` is False (the post raises, like a refused connection)."""
    def __init__(self):
        self.up = True
        self.got = []

    def post(self, url, token, probes):
        if not self.up:
            raise OSError("connection refused")
        assert token == "tok" and url == "https://t.example/api/health"
        self.got.extend(probes)


class BufferTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.state = Path(self.dir.name) / "s.json"
        self.town = Town()
        self.t = 1_800_000_000.0

    def tearDown(self):
        self.dir.cleanup()

    def probe(self, ok):
        res = (True, "ok", {"ok": True, "_ms": 90}) if ok else (False, "URLError: refused", None)
        st = mp.run("https://t.example/api/health", self.state, Quiet(), self.t, res, token="tok", poster=self.town.post)
        self.t += 60
        return st

    def test_failed_probes_buffer_during_an_outage_and_land_on_recovery(self):
        self.assertEqual(self.probe(True)["probes"], [])
        self.assertEqual(len(self.town.got), 1)
        self.town.up = False
        for _ in range(5):
            st = self.probe(False)
        self.assertEqual(len(st["probes"]), 5)
        self.assertTrue(all(p["ok"] is False and p["ms"] is None for p in st["probes"]))
        self.assertEqual(len(self.town.got), 1)
        self.town.up = True
        st = self.probe(True)
        self.assertEqual(st["probes"], [])
        self.assertEqual([p["ok"] for p in self.town.got], [True, False, False, False, False, False, True])
        self.assertEqual(len({p["at"] for p in self.town.got}), 7)
        self.assertEqual(self.town.got[-1]["ms"], 90)

    def test_a_refused_post_keeps_the_buffer(self):
        self.town.up = False
        st = self.probe(True)  # health answered but the post failed (e.g. a bad token)
        self.assertEqual(len(st["probes"]), 1)
        self.town.up = True
        self.assertEqual(self.probe(True)["probes"], [])
        self.assertEqual(len(self.town.got), 2)

    def test_no_token_buffers_and_the_buffer_is_capped_at_7_days(self):
        st = {"probes": [{"at": f"x{i}", "ok": True, "ms": 1} for i in range(mp.BUFFER_MAX + 10)]}
        self.state.write_text(mp.json.dumps(st))
        out = mp.run("https://t.example/api/health", self.state, Quiet(), self.t, (True, "ok", {"ok": True}), token="")
        self.assertEqual(len(out["probes"]), mp.BUFFER_MAX)
        self.assertEqual(out["probes"][0]["at"], "x11")

    def test_probes_url(self):
        self.assertEqual(mp.probes_url("https://muster.town/api/health"), "https://muster.town/api/uptime/probes")


if __name__ == "__main__":
    unittest.main()
