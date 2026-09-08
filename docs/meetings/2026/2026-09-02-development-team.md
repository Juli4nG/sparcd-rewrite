# SPARCd Development Team Meeting Notes

## Meeting details

- **Date:** September 2, 2026
- **Time:** 3:00 p.m.
- **Location:** Science Library
- **Format:** In person
- **Attendees:** Susan Malusa, Julian Gonzalez, Julian Pistorius, and Chris Schnaufer

## Meeting overview

The meeting focused on continued development and testing of the SPARCd Uploader, Tagger, and Explorer applications and the services that support them. The main topics were test-image datasets, prevention of duplicate uploads, object-storage testing and migration, permissions, project governance, and prioritization of user stories.

## Progress updates

- The governance pull request, including `AUTHORS.md` and `CONTRIBUTING.md`, was reviewed, approved, and merged.
- Access to AI development tools and current allocations was not identified as a blocker.
- The pull-request review process is working, but the team agreed that more frequent communication would improve coordination.
- The team reviewed the current MinIO and server work and the remaining steps required before moving object storage to Jetstream.

## Discussion and decisions

### 1. SPARCd applications and shared services

- The team reviewed the relationship among the Uploader, Tagger, Explorer, Admin, and future AI tools.
- The applications should be presented as connected SPARCd tools with shared services where appropriate, including login, permissions, domain configuration, and application-specific settings.
- Permissions must distinguish between authorized users and data or functions that should not be generally accessible.
- The team plans to prototype the permissions structure before the end of September.

### 2. Test and training image datasets

- SPARCd needs a small, controlled image dataset for automated continuous-integration testing and a separate dataset for user training and functional testing.
- These datasets should be representative of the image types and conditions the system must handle, including files with missing or altered timestamps and other known edge cases.
- Generated or templated images are preferred over a large collection of production images because they can be changed to test specific conditions.
- Test images should include visible watermarks or other clear identifiers so they cannot be mistaken for research images.
- Checksums or hashes should be used to identify individual files and support duplicate-detection tests.
- Git LFS and other storage options will be evaluated for managing the test datasets.
- The species list and its current ordering should be included in testing where relevant.

### 3. Duplicate image uploads and location IDs

- The Uploader should detect and prevent duplicate image uploads rather than relying on later database cleanup.
- Duplicate detection should be based on a reliable file identifier, such as a checksum or hash.
- A GitHub issue will document the required behavior and connect it to the earlier duplicate-upload discussion and issue.
- The team also discussed duplicated location IDs. Manual cleanup of the server-side JSON is not a lasting solution if outdated data can be downloaded and uploaded again. The problem needs to be prevented or corrected within the data workflow.

### 4. Object storage, performance, and migration

- Continuous-integration tests should use temporary object-storage services that are created for a test run and removed afterward.
- Upload testing against Jetstream should measure both application performance and the network limit so the source of any bottleneck can be identified.
- SPARCd should remain compatible with the object-storage services required by the project, including S3-compatible services such as MinIO and Jetstream. Broader compatibility should be prioritized against launch requirements rather than attempting to test every available service before release.
- Compatibility requirements and supported services will be documented in issue #197.
- The MinIO-to-Jetstream migration will proceed after testing is complete. Users will receive at least one day's notice before the production cutover.

### 5. User stories and project organization

- User stories will be moved from the wiki into GitHub issues so they can be prioritized and linked directly to acceptance criteria, implementation issues, and pull requests.
- The team will consider a dedicated user-story issue type to make these items easier to identify and track.
- Each user story will be assigned a MoSCoW priority: **Must Have, Should Have, Could Have,** or **Won't Have at this time**.
- The prioritized stories will be organized in GitHub Projects to make launch requirements and later work visible.

### 6. Governance, funding, and communication

- With the governance documents merged, development should continue under the agreed contribution and review process.
- Susan and Julian Pistorius will continue work on establishing an Open Collective for the project.
- Team members will use Signal more frequently for short development updates and coordination between meetings.

## Action items

### Chris Schnaufer

- Modify the continuous-integration pipeline to use temporary object-storage services for testing.
- Test upload performance to Jetstream and determine the effective network limit.
- Plan and complete the Jetstream object-storage cutover after testing, with at least one day's notice to users.

### Julian Gonzalez

- Create or complete the GitHub issue for detecting and preventing duplicate image uploads, referencing discussion #28 and issue #86.
- Create or refine issues #192 and #193 for the generated CI test dataset and the user-training dataset.
- Create or complete issue #197 documenting required compatibility with object-storage services.
- Continue coordinating with Chris and integrate the changes and conditions discussed during the meeting.

### Julian Pistorius

- Help Susan configure the SSH key needed for Julian Gonzalez's server access.
- Work with Susan on establishing the Open Collective.
- Assist with planning and testing for the Jetstream cutover.

### Susan Malusa

- Add Julian Gonzalez's SSH key to the SPARCd server with help from Julian Pistorius.
- Continue setting up the Open Collective with Julian Pistorius.
- Apply MoSCoW priorities to the user stories and update the requirements documentation.
- Organize the prioritized user stories in GitHub Projects and link them to relevant acceptance criteria and development work.
- Create or finalize the MinIO-to-Jetstream migration issue with the required testing and cutover steps.

### All team members

- Use Signal more frequently to coordinate active development work.
- Keep user stories, issues, acceptance criteria, and pull requests linked in GitHub.
- Keep technical explanations and application instructions clear for nontechnical users.

## Open questions

- Where will the CI test dataset and user-training dataset be stored and maintained?
- Which image conditions and file variations must be represented in each dataset?
- Which object-storage services are required for launch, and which can be tested after launch?
- How should species-list order and updates be tested across the applications?
- What application-level validation will permanently prevent duplicate location IDs from returning?
