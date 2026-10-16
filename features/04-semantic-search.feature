@F4 @wip
Feature: Semantic search across history and branches
  As a developer
  I want to search by meaning across all timelines
  So that I can find where an idea lives or lived

  Scenario: Search by concept
    When I run "git sem search 'retry with backoff'"
    Then I see matching entities across all branches and history
    And each result shows its commit, branch, and similarity

  Scenario: Search includes abandoned worlds
    Given a deleted branch is still reachable via reflog
    When I search with "--include-unreachable"
    Then results from that branch are included and labeled as such
