# pulse

Outside witness for [classeve.com](https://classeve.com). Every five minutes,
from GitHub's infrastructure, this repository checks that the public ClassEve
surfaces answer — the website, the API health endpoints, the sign-in
service, the published download artifacts, and the Play listing — and commits
the result to [`pulse.json`](./pulse.json).

It exists because a monitor that lives inside the system it watches cannot see
that system disappear. This one lives somewhere else entirely.

It probes only what any visitor's browser can reach, holds no credentials
beyond a signature used to report results, and stores nothing about anyone.
