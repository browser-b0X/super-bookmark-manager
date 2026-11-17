"""The browser extension's side of the app: a one-time pairing code, a token, and "is this page saved?".
Synthetic database and data folder only.

Run: python -B frontend/tests/extension_backend.py
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
FIXTURE = Path(tempfile.mkdtemp(prefix="extension-backend-"))
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = str(FIXTURE / "data")
os.environ["SAVED_POSTS_DB_PATH"] = str(FIXTURE / "library.sqlite")
import storage  # noqa: E402
import app as dashboard  # noqa: E402
import extension_pairing  # noqa: E402

EXT = {"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}
# What the browser sends with Settings' own requests (a GET has no Origin, but says same-origin).
APP = {"Sec-Fetch-Site": "same-origin"}
AT = "2026-10-24T10:00:00Z"


def post(name, shelf="food"):
    return {"id": f"x-{name}", "url": f"https://{name}.example.invalid/page?utm_source=x", "source": "browser", "platform": "web",
            "domain": f"{name}.example.invalid", "status": "inbox", "createdAt": AT, "updatedAt": AT,
            "metadataStatus": "partial", "categories": [shelf], "tags": [], "projectIds": [], "title": f"Page {name}"}


class Pairing(unittest.TestCase):
    def setUp(self):
        storage.config.DB_PATH = str(FIXTURE / f"{self._testMethodName}.sqlite")
        storage.init_db()
        extension_pairing._path().unlink(missing_ok=True)
        extension_pairing._code = None
        self.client = dashboard.app.test_client()

    def code(self):
        answer = self.client.post("/api/extension/code", json={}, headers=APP)
        self.assertEqual(answer.status_code, 200)
        return answer.json["code"]["code"]

    def pair(self, code, nonce="ab" * 16, origin="http://127.0.0.1:80", **headers):
        """As the extension's options do, keeping going even if the app's proof doesn't fit `code`, as a program would."""
        typed = code.upper().replace("-", "").replace(" ", "")
        asked = self.client.post("/api/extension/pair", json={"nonce": nonce}, headers={**EXT, **headers})
        if asked.status_code != 200:
            return asked
        proof = hmac.new(typed.encode(), f"browser|{nonce}|{asked.json['challenge']}|{origin}".encode(), hashlib.sha256).hexdigest()
        return self.client.post("/api/extension/pair", json={"nonce": nonce, "proof": proof, "browser": "Chrome"}, headers={**EXT, **headers})

    def signed(self, code, message):
        return hmac.new(code.replace("-", "").encode(), message.encode(), hashlib.sha256).hexdigest()

    def test_the_app_shows_it_knows_the_code_first_and_signs_what_it_hands_out(self):
        code = self.code()
        nonce = "cd" * 16
        asked = self.client.post("/api/extension/pair", json={"nonce": nonce}, headers=EXT).json
        self.assertEqual(asked["proof"], self.signed(code, f"app|{nonce}|{asked['challenge']}|http://127.0.0.1:80"))
        self.assertEqual(set(asked), {"ok", "challenge", "proof"}, "nothing else before the extension has shown anything")
        proof = self.signed(code, f"browser|{nonce}|{asked['challenge']}|http://127.0.0.1:80")
        answer = self.client.post("/api/extension/pair", json={"nonce": nonce, "proof": proof}, headers=EXT).json
        self.assertEqual(answer["proof"], self.signed(code, f"token|{nonce}|{asked['challenge']}|http://127.0.0.1:80|{answer['id']}|{answer['token']}"))

    def test_a_proof_made_for_another_address_is_wrong(self):
        # So a program on another port can't pass the extension's request on to this app.
        code = self.code()
        self.assertEqual(self.pair(code, origin="http://127.0.0.1:5001").json["error"], "wrong")
        self.assertEqual(self.pair(code).status_code, 200, "one wrong try, like any other")

    def test_one_go_per_challenge_and_no_second_step_without_the_first(self):
        code = self.code()
        nonce = "ab" * 16
        proof = self.signed(code, f"browser|{nonce}|{'0' * 32}|http://127.0.0.1:80")
        self.assertEqual(self.client.post("/api/extension/pair", json={"nonce": nonce, "proof": proof}, headers=EXT).json["error"], "wrong")
        asked = self.client.post("/api/extension/pair", json={"nonce": nonce}, headers=EXT).json
        bad = self.client.post("/api/extension/pair", json={"nonce": nonce, "proof": "0" * 64}, headers=EXT)
        self.assertEqual(bad.json["error"], "wrong")
        proof = self.signed(code, f"browser|{nonce}|{asked['challenge']}|http://127.0.0.1:80")
        self.assertEqual(self.client.post("/api/extension/pair", json={"nonce": nonce, "proof": proof}, headers=EXT).json["error"], "wrong", "that challenge had its go")

    def test_the_code_itself_is_not_accepted(self):
        code = self.code()
        for body in ({"code": code, "browser": "Chrome"}, {"nonce": "x"}, {"nonce": "x", "proof": "y"}, {"nonce": "ab" * 16, "proof": code}, {}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post("/api/extension/pair", json=body, headers=EXT).status_code, 400)
        self.assertEqual(extension_pairing._code["attempts"], 0, "and those can't wear the code out")

    def test_a_code_works_once_and_gives_a_token_that_answers_whether_a_page_is_saved(self):
        storage.save_library({"posts": [post("bread"), post("walks", "other")], "deletedUrls": []})
        code = self.code()
        self.assertRegex(code, r"^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$")
        self.assertEqual(self.client.get("/api/extension", headers=APP).json["code"]["code"], code, "Settings shows it while it works")
        answer = self.pair(code.lower().replace("-", " "))
        self.assertEqual(answer.status_code, 200, answer.json)
        self.assertEqual(answer.headers["Cross-Origin-Resource-Policy"], "cross-origin")
        token, connection = answer.json["token"], answer.json["id"]
        self.assertEqual(self.pair(code).json, {"ok": False, "error": "expired"}, "used once")
        self.assertIsNone(self.client.get("/api/extension", headers=APP).json["code"])
        status = lambda url, **h: self.client.get("/api/extension/status", query_string={"url": url}, headers={**EXT, "X-SBM-Pair": token, **h})
        saved = status("https://bread.example.invalid/page?utm_source=x")
        self.assertEqual(saved.json, {"ok": True, "saved": True, "title": "Page bread", "shelf": "food"})
        self.assertEqual(status("https://walks.example.invalid/page?utm_source=x").json["shelf"], "", "'other' isn't a shelf to name")
        self.assertEqual(status("https://nowhere.example.invalid/").json, {"ok": True, "saved": False})
        self.assertEqual(status("javascript:alert(1)").json, {"ok": True, "saved": False})
        self.assertEqual(self.client.get("/api/extension/ping", headers={**EXT, "X-SBM-Pair": token}).json, {"ok": True})
        # Only a hash of the token is kept, and Settings never sees it.
        stored = extension_pairing._path().read_text(encoding="utf-8")
        self.assertNotIn(token, stored)
        connections = self.client.get("/api/extension", headers=APP).json["connections"]
        self.assertEqual([c["browser"] for c in connections], ["Chrome"])
        self.assertNotIn("hash", connections[0])
        # Disconnect: the token stops working.
        # Before sending the token anywhere, the extension asks for proof: an HMAC, keyed by the token's hash, of its
        # nonce and the address this server really listens on (its socket's port; the test client's is 80).
        nonce = "ab" * 16
        hello = self.client.get("/api/extension/hello", query_string={"id": connection, "nonce": nonce}, headers=EXT)
        key = hashlib.sha256(token.encode()).hexdigest().encode()
        self.assertEqual(hello.json["proof"], hmac.new(key, f"{nonce}|http://127.0.0.1:80".encode(), hashlib.sha256).hexdigest())
        # A program passing requests on can't make it sign another port with a Host header.
        forwarded = self.client.get("/api/extension/hello", query_string={"id": connection, "nonce": nonce}, headers={**EXT, "Host": "127.0.0.1:5001"})
        self.assertEqual(forwarded.json["proof"], hello.json["proof"])
        self.assertNotIn(token, hello.get_data(as_text=True))
        self.assertEqual(self.client.get("/api/extension/hello", query_string={"id": "nope", "nonce": nonce}, headers=EXT).status_code, 404)
        self.assertEqual(self.client.get("/api/extension/hello", query_string={"id": connection, "nonce": "x"}, headers=EXT).status_code, 404)
        self.assertEqual(connections[0]["id"], connection)
        self.assertEqual(self.client.delete(f"/api/extension/{connections[0]['id']}", headers=APP).status_code, 200)
        self.assertEqual(status("https://bread.example.invalid/page").status_code, 401)

    def test_wrong_codes_wear_the_code_out_and_an_old_code_expires(self):
        code = self.code()
        for _ in range(extension_pairing.CODE_ATTEMPTS):
            self.assertEqual(self.pair("2222-2222").json["error"], "wrong")
        self.assertEqual(self.pair(code).json["error"], "used_up", "guessing can't go on")
        code = self.code()
        with patch.object(extension_pairing.time, "time", return_value=extension_pairing._code["expires"] + 1):
            self.assertEqual(self.pair(code).json["error"], "expired")
        self.assertEqual(self.pair("").json["error"], "wrong", "an empty code is just wrong")

    def test_websites_and_unpaired_callers_get_nothing(self):
        code = self.code()
        for origin in ({"Origin": "http://evil.invalid"}, {"Origin": "https://bread.example.invalid"}, {}):
            with self.subTest(origin=origin):
                headers = {**origin} if origin else {}
                self.assertEqual(self.client.post("/api/extension/pair", json={"nonce": "ab" * 16}, headers=headers).status_code, 403)
                # The extension's own reads come without an Origin; then only the token counts.
                self.assertEqual(self.client.get("/api/extension/status?url=https://a.invalid/", headers=headers).status_code, 401 if not origin else 403)
        self.assertEqual(self.client.get("/api/extension/status?url=https://a.invalid/", headers=EXT).status_code, 401)
        self.assertEqual(self.client.get("/api/extension/status?url=https://a.invalid/", headers={**EXT, "X-SBM-Pair": "x" * 43}).status_code, 401)
        # The code and the connections are for the app's own Settings page only: a missing Origin isn't
        # enough (another extension with access to 127.0.0.1 sends none), the browser must say same-origin.
        for call in (lambda h: self.client.get("/api/extension", headers=h), lambda h: self.client.post("/api/extension/code", json={}, headers=h)):
            self.assertEqual(call(EXT).status_code, 403)
            self.assertEqual(call({"Origin": "http://evil.invalid"}).status_code, 403)
            self.assertEqual(call({}).status_code, 403)
            self.assertEqual(call({"Sec-Fetch-Site": "none"}).status_code, 403)
            self.assertEqual(call(APP).status_code, 200)
            self.assertEqual(call({"Origin": "http://localhost"}).status_code, 200)
        self.assertEqual(self.client.post("/api/extension/pair", json={"nonce": "ab" * 16, "extra": 1}, headers=EXT).status_code, 400)

    def test_the_download_buttons_ask_which_posts_on_screen_are_saved(self):
        x_post = {**post("x"), "id": "x-post", "url": "https://x.com/maraquinn/status/1849000000000000001", "domain": "x.com", "categories": ["Recipes"]}
        storage.save_library({"posts": [post("bread"), x_post], "deletedUrls": []})
        token = self.pair(self.code()).json["token"]
        ask = lambda body, **h: self.client.post("/api/extension/saved", json=body, headers={**EXT, "X-SBM-Pair": token, **h})
        answer = ask({"urls": ["https://x.com/maraquinn/status/1849000000000000001", "https://x.com/someone/status/2",
                               "https://bread.example.invalid/page?utm_source=x", "javascript:alert(1)", "y" * 5000]})
        self.assertEqual(answer.status_code, 200, answer.json)
        self.assertEqual(answer.headers["Cross-Origin-Resource-Policy"], "cross-origin")
        self.assertEqual(answer.json, {"ok": True, "items": [{"saved": True, "shelf": "Recipes"}, {"saved": False, "shelf": ""},
                                                             {"saved": True, "shelf": "food"}, {"saved": False, "shelf": ""}, {"saved": False, "shelf": ""}]})
        self.assertNotIn("Page bread", answer.get_data(as_text=True), "saved or not and the shelf, nothing else")
        self.assertEqual(ask({"urls": []}).json, {"ok": True, "items": []})
        for bad in ({"urls": ["https://a.invalid/"] * 51}, {"urls": "https://a.invalid/"}, {"urls": [1]}, {}, ["https://a.invalid/"]):
            with self.subTest(bad=str(bad)[:40]):
                self.assertEqual(ask(bad).status_code, 400)
        # A website, another caller without the extension's origin, or no token: nothing.
        for headers in ({"Origin": "http://evil.invalid"}, {"Origin": "https://x.com"}, {}):
            with self.subTest(headers=headers):
                self.assertEqual(self.client.post("/api/extension/saved", json={"urls": []}, headers={**headers, "X-SBM-Pair": token}).status_code, 403)
        self.assertEqual(self.client.post("/api/extension/saved", json={"urls": []}, headers=EXT).status_code, 401)


if __name__ == "__main__":
    unittest.main(verbosity=1)
