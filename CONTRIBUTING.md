### Contributing to sparcd-exploration

* The contributors are listed in [AUTHORS.md](https://github.com/CulverLab/sparcd-exploration/blob/main/AUTHORS.md) (add yourself).
* This project is licensed under the GPL v3, see [LICENSE](https://github.com/CulverLab/sparcd-exploration/blob/main/LICENSE).
* We use the [C4 (Collective Code Construction Contract)](https://rfc.zeromq.org/spec/44/) process for contributions.
Please read this if you are unfamiliar with it. The decision to adopt C4 is
[recorded in this discussion](https://github.com/orgs/CulverLab/discussions/11).
* Each `apps/<name>/` is one tool that does one thing well. When a need doesn't fit an existing app, propose a new app rather than growing the old one.
* Prefer designs that ship as a static bundle (Pyodide / WASM in the browser, prebuilt data files, signed S3 URLs)
* Please maintain the existing code style.
* Please try to keep your commits small and focussed.
* If the project diverges from your branch, please rebase instead of merging. This makes the commit graph easier to read.
