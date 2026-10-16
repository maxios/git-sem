@F16
Feature: Adopt an existing project
  As a developer with years of history
  I want git-sem to index the commits that already exist
  So that the whole project has meaning, not only new commits

  Background:
    Given a git repository with 5 existing commits
    And the semantic engine is the test engine with model "m1"

  Scenario: Init leaves history alone unless asked
    When I run "git sem init"
    Then 0 commits are queued for indexing
    And the engine has not been invoked

  Scenario: Backfill on init runs in the background
    Given the test engine takes 400 milliseconds to respond
    When I run "git sem init --backfill"
    Then the command took less than 1000 milliseconds
    And every commit on the current branch eventually has an intent

  Scenario: Backfill progress is visible
    Given the test engine takes 400 milliseconds to respond
    When I run "git sem init --backfill"
    Then git sem status eventually reports indexing progress out of 5
    And every commit on the current branch eventually has an intent
