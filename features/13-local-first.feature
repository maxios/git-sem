@F13
Feature: Local-first operation
  As a developer
  I want the layer to work offline on my machine
  So that I am not dependent on a remote service

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled
    And I commit "src/net.ts" with a function "retryWithBackoff"
    And I run "git sem index"

  Scenario: Offline queries
    Given the repository has no remotes
    When I run "git sem search 'retry'"
    Then the results come from the local index
    And the last command did not invoke the engine

  Scenario: Index is disposable
    Given I run "git sem search 'retry'"
    And the local index is deleted
    When I run "git sem rebuild"
    Then the local index exists again
    And the last command did not invoke the engine
    When I run "git sem search 'retry'"
    Then the search results include "retryWithBackoff" labeled "main"
