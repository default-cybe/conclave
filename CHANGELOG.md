## [0.4.29] - 2026-10-25

### Changed

- Legacy .doc, .xls and .ppt are still refused, now with the LibreOffice command that converts them.

### Added

- Read opens Word, Excel and PowerPoint files (docx, xlsx, pptx) and OpenDocument files (odt, ods, odp) as Markdown: headings, paragraphs, lists and tables; one table per sheet (the first 500 rows, with a note); one section per slide with its notes. Long documents page with offset and limit. The files are unzipped on the hub with no new dependency, so they work on paired devices too.
- Optional Docling server: set `documents.docling.url` (http or https, LAN is fine) and Read sends scanned PDFs, PDFs with tables, and docx, xlsx and pptx files to docling-serve for Markdown with OCR and table structure, falling back to the built-in readers on any error. Members' sessions never use it. `docs/research/DOCLING-MADX.md` has the commands to run it CPU-only in an LXC.

### Fixed

- Installing or updating a plugin now installs its Node dependencies (`npm ci`, or `npm install` without a package-lock, with `--omit=dev --ignore-scripts`, 2 minute limit), so hooks that `require()` a package (ECC's SessionStart and `js-yaml`) no longer fail with "Cannot find module". When that install fails, the plugin stays installed and Extensions > Plugins shows the command to run by hand.