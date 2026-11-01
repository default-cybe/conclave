# Contributing to Conclave

Thanks for your interest. Conclave is a small project run by one person, so keep changes focused and easy to review.

## How to contribute

1. Open an issue first for anything larger than a small fix, so we can agree on the approach before you write code.
2. Fork the repository and create a branch from `main`.
3. Set up and check your change:

   ```bash
   bun install
   bun run typecheck
   bun test
   ```

   For the Rust daemon or desktop app, also run `cargo test` in `packages/daemon-rs` or `packages/desktop/src-tauri`. For the Android app, run `./gradlew test` in `packages/android`.
4. Keep one change per pull request. Add or update tests for behavior you change.
5. Open a pull request that says what changed and why, and tick the CLA box in the template.

Report security issues privately to the author through GitHub (default-cybe), not in a public issue.

## Contributor License Agreement

By submitting a contribution (code, documentation or any other material) to this project, you agree to the following:

1. **License grant.** You grant Kaivalya Ahir (GitHub: default-cybe), the author of Conclave, a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable license to use, reproduce, modify, prepare derivative works of, distribute, sublicense and relicense your contribution, including under licenses other than AGPL-3.0-only (for example, a commercial license).
2. **Patent grant.** You grant the same parties a perpetual, worldwide, no-charge, royalty-free, irrevocable patent license for any of your patent claims that your contribution necessarily infringes, alone or combined with the project.
3. **Your right to contribute.** You confirm that the contribution is your original work, or that you otherwise have the right to submit it under these terms. If your employer has rights to your work, you confirm that you have permission to contribute it. If any part comes from someone else, you identify it and its license in the pull request.
4. **You keep your copyright.** This agreement does not transfer ownership. You remain free to use your contribution in any other way.
5. **No warranty.** You provide your contribution "as is", without warranties of any kind.

The project as a whole stays available under AGPL-3.0-only (see [LICENSE](LICENSE)).
