#!/usr/bin/env python3
"""External pinger for muster.town (grant gr_rntk0echpi, design dc_f2hpf9u1ya). Python 3 stdlib only.

One probe per run (a systemd timer runs it every 60 s): GET <url>/api/health with a 10 s timeout. A probe fails on no
response, a non-200 or `ok` not true. After 3 failed probes in a row the pinger sends a RED alert by SMS (Twilio REST)
and email (Gmail SMTP, STARTTLS on 587); while health stays down it reminds at most every 6 h; when health answers again
it sends one "recovered" message. As a backstop, when the server reports `monitor.outbound: false` (its own senders
aren't set up), the pinger forwards the red alerts listed in health `monitor.alerts` on change only: once when a key
turns red, a reminder every 6 h while it stays red, and once when it is no longer red. Never on every probe.

Secrets come from an env file (default ~/.miniclaw/muster-pinger.env), with the server's names:
ALERT_TWILIO_SID ALERT_TWILIO_AUTH ALERT_TWILIO_FROM ALERT_SMS_TO ALERT_EMAIL_TO ALERT_SMTP_USER ALERT_SMTP_PASS
State (failure streak, last alert times) is a JSON file (default ~/.miniclaw/muster-pinger.json).

  muster_pinger.py [--url URL] [--env FILE] [--state FILE] [--dry-run]

--dry-run prints each message instead of sending it (state is still written, so a repeat run behaves like the timer).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from pathlib import Path

ENV_NAMES = ["ALERT_TWILIO_SID", "ALERT_TWILIO_AUTH", "ALERT_TWILIO_FROM", "ALERT_SMS_TO", "ALERT_EMAIL_TO", "ALERT_SMTP_USER", "ALERT_SMTP_PASS"]
CHANNEL_ENV = {"sms": ENV_NAMES[:4], "email": ["ALERT_EMAIL_TO", "ALERT_SMTP_USER", "ALERT_SMTP_PASS"]}
FAILS_FOR_RED = 3
REALERT_S = 6 * 3600
TIMEOUT_S = 10


def load_env(path: Path) -> dict[str, str]:
    """KEY=value lines; blank lines and # comments skipped; optional quotes stripped. Process env fills what's missing."""
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip().removeprefix("export ").strip()
            env[k] = v.strip().strip("'\"")
    for k in ENV_NAMES:
        if not env.get(k) and os.environ.get(k):
            env[k] = os.environ[k]
    return env


def probe(url: str) -> tuple[bool, str, dict | None]:
    """(ok, why, health body or None)."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "muster-pinger"}), timeout=TIMEOUT_S) as r:
            body = r.read()
            if r.status != 200:
                return False, f"HTTP {r.status}", None
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}", None
    except Exception as e:  # timeouts, DNS, TLS, refused
        return False, f"{type(e).__name__}: {e}"[:200], None
    try:
        h = json.loads(body)
    except ValueError:
        return False, "health is not JSON", None
    if h.get("ok") is not True:
        return False, "health ok is not true", h
    return True, "ok", h


class Sender:
    def __init__(self, env: dict[str, str], dry_run: bool):
        self.env = env
        self.dry_run = dry_run
        self.missing = [k for k in ENV_NAMES if not env.get(k, "").strip()]

    def send(self, sms: str, subject: str, body: str) -> None:
        if self.dry_run:
            print(f"[dry-run] SMS: {sms[:300]}")
            print(f"[dry-run] email: {subject}\n{body}")
            return
        for name, f in (("sms", lambda: self.sms(sms[:300])), ("email", lambda: self.email(subject, body))):
            gap = [k for k in CHANNEL_ENV[name] if k in self.missing]
            if gap:  # each channel sends on its own, so SMS works without the SMTP pair and vice versa
                print(f"muster-pinger: {name} not sent, missing {', '.join(gap)}: {subject}", file=sys.stderr)
                continue
            try:
                f()
                print(f"muster-pinger: {name} sent: {subject}")
            except Exception as e:  # one failing channel must not stop the other
                print(f"muster-pinger: {name} failed: {type(e).__name__}: {e}"[:300], file=sys.stderr)

    def sms(self, text: str) -> None:
        e = self.env
        sid = e["ALERT_TWILIO_SID"].strip()
        data = urllib.parse.urlencode({"From": e["ALERT_TWILIO_FROM"].strip(), "To": e["ALERT_SMS_TO"].strip(), "Body": text}).encode()
        req = urllib.request.Request(f"https://api.twilio.com/2010-04-01/Accounts/{urllib.parse.quote(sid)}/Messages.json", data=data, method="POST")
        req.add_header("authorization", "Basic " + base64.b64encode(f"{sid}:{e['ALERT_TWILIO_AUTH'].strip()}".encode()).decode())
        with urllib.request.urlopen(req, timeout=15) as r:
            if r.status >= 300:
                raise RuntimeError(f"Twilio {r.status}")

    def email(self, subject: str, text: str) -> None:
        e = self.env
        msg = EmailMessage()
        msg["From"] = f"muster.town pinger <{e['ALERT_SMTP_USER'].strip()}>"
        msg["To"] = e["ALERT_EMAIL_TO"].strip()
        msg["Subject"] = subject
        msg.set_content(text)
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=20) as s:
            s.starttls(context=ssl.create_default_context())
            s.login(e["ALERT_SMTP_USER"].strip(), e["ALERT_SMTP_PASS"].strip())
            s.send_message(msg)


def run(url: str, state_path: Path, sender: Sender, now: float, result: tuple[bool, str, dict | None]) -> dict:
    """One probe's worth of state change and messages. Returns the new state (also written to state_path)."""
    try:
        st = json.loads(state_path.read_text())
    except (OSError, ValueError):
        st = {}
    fails = int(st.get("fails", 0))
    red_since = st.get("redSince")
    last_alert = float(st.get("lastAlertAt", 0))
    forwarded: dict[str, float] = st.get("forwarded", {})
    ok, why, health = result
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))

    if ok:
        if red_since:
            down_min = round((now - float(red_since)) / 60) + FAILS_FOR_RED - 1
            sender.send(f"muster.town recovered: health OK again after about {down_min} min down.",
                        "[muster.town] recovered: health OK",
                        f"{url} answered OK at {stamp} after about {down_min} min down (red since {time.strftime('%H:%M:%SZ', time.gmtime(float(red_since)))}).")
        fails, red_since, last_alert = 0, None, 0.0
        # backstop: red alerts the server could not send itself
        # backstop: red alerts the server could not send itself, on change only (new red, 6-hourly reminder, cleared)
        mon = (health or {}).get("monitor") or {}
        open_red = {a.get("key"): a for a in mon.get("alerts", []) if a.get("level") == "red"}
        if mon.get("outbound") is False:
            for key, a in open_red.items():
                if key not in forwarded or now - float(forwarded[key]) >= REALERT_S:
                    still = "still " if key in forwarded else ""
                    sender.send(f"muster.town {still}RED: {key} = {a.get('value')} (since {a.get('since')}); forwarded by the pinger.",
                                f"[muster.town] {still}RED: {key}",
                                f"The server's monitor has a red alert it can't send itself (monitor.outbound false):\n\n{json.dumps(a, indent=2)}\n\n"
                                f"The pinger reminds every {REALERT_S // 3600} h while it stays red and sends one message when it clears.\n{url}")
                    forwarded[key] = now
            for key in [k for k in forwarded if k not in open_red]:
                sender.send(f"muster.town cleared: {key} is no longer red.", f"[muster.town] cleared: {key}",
                            f"The server's monitor no longer lists {key} as red at {stamp}.\n{url}")
            forwarded = {k: t for k, t in forwarded.items() if k in open_red}
        else:
            forwarded = {}  # the server sends its own alerts (or health has no monitor block)
    else:
        fails += 1
        print(f"muster-pinger: probe failed ({fails} in a row): {why}", file=sys.stderr)
        if fails >= FAILS_FOR_RED:
            if not red_since:
                red_since = now
                sender.send(f"muster.town RED: health down for {fails} probes ({why}).", "[muster.town] RED: health check failing",
                            f"{url} failed {fails} probes in a row (one a minute). Last: {why}\nAt {stamp}.")
                last_alert = now
            elif now - last_alert >= REALERT_S:
                mins = round((now - float(red_since)) / 60) + FAILS_FOR_RED - 1
                sender.send(f"muster.town still RED: health down about {mins} min ({why}).", "[muster.town] still RED: health check failing",
                            f"{url} has been failing for about {mins} min. Last: {why}\nAt {stamp}.")
                last_alert = now

    new = {"fails": fails, "redSince": red_since, "lastAlertAt": last_alert, "forwarded": forwarded, "lastProbeAt": stamp, "lastResult": why}
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(new))
    tmp.replace(state_path)
    return new


def main(argv: list[str] | None = None) -> int:
    home = Path.home() / ".miniclaw"
    ap = argparse.ArgumentParser(description="Probe muster.town health; alert by SMS and email after 3 failures.")
    ap.add_argument("--url", default="https://muster.town/api/health")
    ap.add_argument("--env", type=Path, default=home / "muster-pinger.env")
    ap.add_argument("--state", type=Path, default=home / "muster-pinger.json")
    ap.add_argument("--dry-run", action="store_true", help="print messages instead of sending them")
    a = ap.parse_args(argv)
    sender = Sender(load_env(a.env), a.dry_run)
    st = run(a.url, a.state, sender, time.time(), probe(a.url))
    print(f"muster-pinger: {st['lastResult']} (fails {st['fails']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
