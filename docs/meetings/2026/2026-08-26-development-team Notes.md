# SPARCd Development Team Meeting Notes

## Meeting details

- **Date:** August 26, 2026
- **Time:** 3:00 p.m.
- **Location:** Science Library and Zoom
- **Format:** Hybrid
- **In person:** Susan Malusa, Julian Pistorius, Chris Schnaufer
- **Remote:** Julian Gonzalez

## Purpose

The meeting focused on four immediate needs: resolving upload and storage performance problems, planning the move from MinIO to Jetstream, strengthening the GitHub development process, and simplifying the SPARCd interfaces for community scientists.

## Key decisions and agreements

### 1. Storage performance and migration

- The current upload process is too slow and must be addressed as a priority. Recent work has taken 8–10 hours in situations that previously took about 20 minutes.
- MinIO will be replaced as SPARCd's primary object-storage service. Jetstream is the planned destination.
- Julian Gonzalez demonstrated a sharded proxy approach that reached approximately 60–80 MB/s in testing by using HTTP/2 and multiple simultaneous connections.
- Before any production change, the team will test the full migration process with the `research1` and `research2` environments. Testing must include the Java application, web application, and Explorer.
- After successful end-to-end testing, the production endpoint will be switched to Jetstream. A maintenance page will be used during the cutover.
- The migration issue should document the test sequence, acceptance criteria, rollback plan, DNS or CNAME changes, and communication to users.

### 2. Proxy and performance testing

- The team discussed a low-maintenance proxy that could run on demand through a serverless service such as AWS Lambda or Cloudflare Workers.
- Browser-side caching and ETags may reduce unnecessary file transfers by refreshing data only when it changes.
- Performance testing should separate local application limits, network performance, and object-storage performance so bottlenecks can be identified clearly.
- More complex optimizations, such as incremental file updates, will be considered only if testing shows they are necessary.

### 3. GitHub workflow and project coordination

- GitHub issues will be the starting point for development work. Team members should assign themselves to an issue before beginning work so effort is visible and duplicate work is avoided.
- GitHub Projects, milestones, and issue priorities will be used to organize the remaining work and the delivery timeline.
- The project plan should distinguish product deliverables from development-process work. Process improvements should support delivery of the SPARCd applications rather than become the primary product.
- Work should be divided according to team members' skills and availability, with ownership visible in GitHub.
- Design decisions, requirements, implementation work, tests, and pull requests should remain linked in GitHub.
- Proposed interface changes must be captured as issues before implementation.

### 4. Governance and pull-request requirements

- The team agreed to adapt the C4 (Collective Code Construction Contract) model used by ZeroMQ as the basis for SPARCd's governance and contribution process.
- The C4 model is relevant because SPARCd has public software contracts, including shared file formats and APIs.
- Every change should begin with a GitHub issue that clearly defines the problem to be solved.
- For each proposed solution, the issue or pull request should state what successful behavior would look like and how the team will verify that it works.
- The governance document will define how problems are proposed, how solutions are reviewed, what qualifies for lazy consensus, the review period, and what must be completed before code is merged.
- Continuous integration will enforce pull-request requirements, including behavior-driven development tests, code-coverage checks, and protection against removing or weakening tests simply to make a pull request pass.
- Pull requests should receive adversarial review: the reviewer should actively look for failure cases, missing requirements, regressions, and unsupported assumptions.
- AI-assisted code must meet the same issue-linking, testing, review, and documentation standards as other code.

### 5. AI-assisted development and review

- The team discussed using AI tools, including Greptile and Codex, to support code review, testing, and development.
- Different developers and AI agents may produce inconsistent approaches. Shared specifications and acceptance tests are needed so work from different tools can be evaluated against the same requirements.
- The team will consider using multiple models, including using one model to critically review another model's output, when the additional review is useful.
- Cost and access remain concerns. Susan will investigate whether the University of Arizona provides AI allocations, discounted access, or other suitable resources.
- AI review may supplement the development process, but required automated checks and human review remain part of the pull-request workflow.

### 6. Application priorities and citizen-science interfaces

- Product planning will address the Explorer, Uploader, Tagger, and Admin applications as distinct but connected parts of SPARCd.
- SPARCd needs an admin application for authorized users to manage initial setup, configuration, failed uploads, and data cleanup.
- Susan will write user stories for the admin application before development begins.
- Explorer work should include performance and analysis needs as part of its requirements.
- The Uploader and Tagger should use short, plain instructions that are understandable to nontechnical community scientists.
- The Tagger redesign should give more screen space to images and improve navigation.
- Preview functions will remain separate from the core upload and tagging workflows.

## Action items

### Julian Gonzalez

- Implement continuous integration checks for pull requests, including BDD tests, code coverage, and test-protection requirements.
- Apply for Greptile's open-source program.
- Document the proxy setup and continue improvements to the Uploader.
- Organize initial issue priorities, milestones, and the GitHub Projects workflow.

### Susan Malusa

- Ask Matt and Andy about University of Arizona AI allocations, discounts, and available inference resources.
- Write user stories for the admin application.
- Create a GitHub issue for the MinIO-to-Jetstream migration, including the `research1` and `research2` test plan.
- Notify the community-science team about the expected migration and maintenance period.
- Review existing GitHub issues, assign herself to the items she will address, and add issues for the proposed Tagger and other interface changes.

### All team members

- Use assigned GitHub issues to coordinate work and prevent duplication.
- Review and finalize the SPARCd governance document based on C4.
- Define the permitted uses, notice period, and decision threshold for lazy consensus.
- Adopt a shared pull-request checklist covering the problem statement, expected behavior, BDD tests, code coverage, test protection, and adversarial review.
- Use shared specifications and acceptance criteria when work is produced with different AI tools.
- Confirm migration acceptance criteria and the rollback procedure before the production endpoint is changed.

## Open questions

- Which proxy deployment option best meets the project's cost, maintenance, and performance needs?
- What performance thresholds must the Jetstream migration meet before production cutover?
- Will DNS be changed directly, or will a CNAME or project-controlled domain be used?
- What maintenance window and user notice are required for the migration?
- What forms of adversarial or multi-model review should be required, and when would the added cost be justified?

## Next meeting

- **Wednesday, September 2, 2026, at 3:00 p.m.**
- **Location:** Science Library, with remote participation available
