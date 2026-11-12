"""Pinger alert tests (grant gr_hbz0twkfp9: it only alerts, posts nothing): python3 -m unittest discover -s deploy/pinger"""
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


class AlertTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.state = Path(self.dir.name) / "s.json"
        self.sender = Quiet()
        self.t = 1_800_000_000.0

    def tearDown(self):
        self.dir.cleanup()

    def probe(self, ok):
        res = (True, "ok", {"ok": True, "_ms": 90}) if ok else (False, "URLError: refused", None)
        st = mp.run("https://t.example/api/health", self.state, self.sender, self.t, res)
        self.t += 60
        return st

    def test_red_after_three_failures_then_one_recovery(self):
        self.probe(True)
        for _ in range(5):
            st = self.probe(False)
        self.assertEqual(st["fails"], 5)
        self.assertEqual(self.sender.sent, ["[muster.town] RED: health check failing"])
        st = self.probe(True)
        self.assertEqual(st["fails"], 0)
        self.assertEqual(self.sender.sent[-1], "[muster.town] recovered: health OK")

    def test_an_old_state_with_a_probe_buffer_drops_it(self):
        self.state.write_text(mp.json.dumps({"probes": [{"at": "x", "ok": True, "ms": 1}]}))
        self.assertNotIn("probes", self.probe(True))
        self.assertFalse(hasattr(mp, "post_probes"))


if __name__ == "__main__":
    unittest.main()
