@F4
Feature: Semantic search across history and branches
  As a developer
  I want to search by meaning across all timelines
  So that I can find where an idea lives or lived

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled
    And I commit "src/user.ts" with a function "loadUser"

  Scenario: Search by concept
    Given branch "feature" adds "src/net.ts" with a function "retryWithBackoff"
    And I run "git sem index"
    When I run "git sem search 'retry with backoff'"
    Then the top search result is the entity "retryWithBackoff" on branch "feature"
    And each search result shows its commit, branch and similarity
    And the last command did not invoke the engine

  Scenario: Search includes abandoned worlds
    Given branch "spike" adds "src/cache.ts" with a function "warmCacheEagerly"
    And I run "git sem index"
    And I delete the branch "spike"
    When I run "git sem search 'warm cache eagerly'"
    Then the search results do not include "warmCacheEagerly"
    When I run "git sem search 'warm cache eagerly' --include-unreachable"
    Then the search results include "warmCacheEagerly" labeled "unreachable"
