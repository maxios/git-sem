@F1
Feature: Non-blocking semantic indexing
  As a developer
  I want semantics computed in the background
  So that git stays as fast as it is today

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"

  Scenario: Commit is never slowed by inference
    Given background indexing is disabled
    When I commit a change to "src/retry.ts"
    Then the commit succeeds
    And the commit is queued for indexing
    And the engine has not been invoked
    And the post-commit hook finishes in under 300 milliseconds

  Scenario: Unchanged content is never recomputed
    Given background indexing is disabled
    And I commit "config.env" with content "RETRIES=3"
    And I commit "config.env" with content "RETRIES=5"
    And I commit "config.env" with content "RETRIES=3"
    When I run "git sem index"
    Then the last index run computed 2 file artifacts and reused 1

  Scenario: Indexing catches up after downtime
    Given background indexing is disabled
    When I commit a change to "src/a.ts"
    And I commit a change to "src/b.ts"
    Then 2 commits are queued for indexing
    When I run "git sem index"
    Then the queue is empty
    And every commit on the current branch has an intent

  Scenario: A slow model never blocks the commit
    Given background indexing is enabled
    And the test engine takes 2000 milliseconds to respond
    When I commit a change to "src/retry.ts" with message "Add retry"
    Then the commit succeeds
    And the commit took less than 1000 milliseconds
    And the latest commit is eventually indexed
