import base64

from app.routers.profile import MAX_AVATAR_BYTES

from .conftest import ADMIN, VIEWER

# Smallest valid images of each accepted type
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 60 + b"\xff\xd9"
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 24


def data_url(kind, data):
    return f"data:image/{kind};base64,{base64.b64encode(data).decode()}"


def test_profile_requires_sign_in(api):
    assert api.patch("/api/profile", json={"name": "X"}).status_code == 401
    assert api.get("/api/profile/avatar").status_code == 401
    assert api.put("/api/profile/avatar", json={"preset": 1}).status_code == 401


def test_user_can_rename_themselves(api):
    api.login(VIEWER)
    r = api.patch("/api/profile", json={"name": "  Site Engineer  "})
    assert r.status_code == 200 and r.json()["user"]["name"] == "Site Engineer"
    assert api.get("/api/auth/me").json()["user"]["name"] == "Site Engineer"
    assert api.patch("/api/profile", json={"name": ""}).status_code == 422
    assert api.patch("/api/profile", json={"name": "   "}).status_code == 422


def test_profile_changes_need_the_client_header(api):
    api.login(VIEWER)
    assert api.c.patch("/api/profile", json={"name": "X"}, headers={"X-SHM-Client": ""}).status_code == 403


def test_change_password(api):
    api.login(VIEWER)
    bad = api.post("/api/profile/password", json={"current_password": "wrong", "new_password": "Another-Password-1"})
    assert bad.status_code == 400 and "current password" in bad.json()["detail"]
    assert api.post("/api/profile/password", json={"current_password": VIEWER["password"], "new_password": "short"}).status_code == 422
    assert api.post("/api/profile/password", json={"current_password": VIEWER["password"], "new_password": VIEWER["password"]}).status_code == 400
    ok = api.post("/api/profile/password", json={"current_password": VIEWER["password"], "new_password": "Another-Password-1"})
    assert ok.status_code == 200
    api.post("/api/auth/logout")
    assert api.post("/api/auth/login", json=VIEWER).status_code == 401
    assert api.post("/api/auth/login", json={"email": VIEWER["email"], "password": "Another-Password-1"}).status_code == 200


def test_choose_a_preset_avatar(api):
    api.login(VIEWER)
    assert api.get("/api/auth/me").json()["user"]["avatar"] is None
    r = api.put("/api/profile/avatar", json={"preset": 3})
    assert r.status_code == 200 and r.json()["user"]["avatar"] == "preset:3"
    assert api.get("/api/auth/me").json()["user"]["avatar"] == "preset:3"
    for bad in [{"preset": 0}, {"preset": 5}, {}, {"preset": 1, "image": data_url("png", PNG)}]:
        assert api.put("/api/profile/avatar", json=bad).status_code == 422, bad


def test_upload_serve_and_remove_a_picture(api):
    api.login(VIEWER)
    for kind, data in [("png", PNG), ("jpeg", JPEG), ("webp", WEBP)]:
        r = api.put("/api/profile/avatar", json={"image": data_url(kind, data)})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["avatar"].startswith("upload:")
        img = api.get("/api/profile/avatar")
        assert img.status_code == 200 and img.headers["content-type"] == f"image/{kind}" and img.content == data
        assert img.headers["x-content-type-options"] == "nosniff"
    # choosing a preset afterwards replaces the upload
    api.put("/api/profile/avatar", json={"preset": 2})
    assert api.get("/api/profile/avatar").status_code == 404
    api.put("/api/profile/avatar", json={"image": data_url("png", PNG)})
    r = api.delete("/api/profile/avatar")
    assert r.status_code == 200 and r.json()["user"]["avatar"] is None
    assert api.get("/api/profile/avatar").status_code == 404


def test_upload_rejects_non_images(api):
    api.login(VIEWER)
    cases = [
        data_url("png", b"<svg onload=alert(1)>"),          # claims PNG, is not
        data_url("jpeg", PNG),                               # type does not match the bytes
        "data:image/svg+xml;base64," + base64.b64encode(b"<svg/>").decode(),
        "data:text/html;base64,PGgxPg==",
        "data:image/png;base64,***not base64***",
        "https://example.com/me.png",
    ]
    for c in cases:
        assert api.put("/api/profile/avatar", json={"image": c}).status_code in (400, 422), c[:40]
    big = PNG + b"\x00" * (MAX_AVATAR_BYTES + 1)
    assert api.put("/api/profile/avatar", json={"image": data_url("png", big)}).status_code in (413, 422)
    assert api.get("/api/auth/me").json()["user"]["avatar"] is None


def test_pictures_are_private_to_each_user(api):
    api.login(VIEWER)
    api.put("/api/profile/avatar", json={"image": data_url("png", PNG)})
    api.post("/api/auth/logout")
    api.login(ADMIN)
    assert api.get("/api/profile/avatar").status_code == 404  # the admin sees only their own picture
