@F7
Feature: Semantic merge assistance
  As a developer merging two worlds
  I want the meaning of each side made legible
  So that I can decide quickly and correctly

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled

  Scenario: Compare only co-touched entities
    Given I commit "src/quota.ts" with a function "computeQuota"
    And I commit "src/retry.ts" with a function "retryRequest"
    And I commit "src/page.ts" with a function "renderPage"
    And on branch "a" I change the function "computeQuota" with message "Raise quota for pro plans"
    And on branch "a" I change the function "retryRequest" with message "Retry on 503 responses"
    And on branch "a" I change the function "renderPage" with message "Render the page faster"
    And on branch "b" I change the function "computeQuota" with message "Count only successful uploads"
    And on branch "b" I change the function "retryRequest" with message "Cap retries at three"
    And I run "git sem index"
    When I run "git sem merge-view a b"
    Then the merge view lists exactly the entities "computeQuota" and "retryRequest"
    And each listed entity shows the intent from "a" and the intent from "b"
    And the last command did not invoke the engine

  Scenario: Redundant changes are identified
    Given I commit "src/http.ts" with a function "requestTimeout"
    And on branch "a" I change the function "requestTimeout" with message "Fix the request timeout by raising the limit"
    And on branch "b" I change the function "requestTimeout" with message "Fix the request timeout with a retry"
    And I run "git sem index"
    When I run "git sem merge-view a b"
    Then the merge view flags "requestTimeout" as likely redundant
    And the output contains "Decision: yours"

  Scenario: The layer never auto-resolves
    Given I commit "config.env" with content "RETRIES=3"
    And on branch "a" I commit "config.env" with content "RETRIES=4"
    And on branch "b" I commit "config.env" with content "RETRIES=5"
    And I merge branch "b" into "a" with conflicts
    When I run "git sem resolve config.env"
    Then the output contains "not written"
    And "config.env" still contains conflict markers
    When I run "git sem resolve config.env --accept"
    Then "config.env" contains "RETRIES=4" and "RETRIES=5" without conflict markers
    And "config.env" is not staged
