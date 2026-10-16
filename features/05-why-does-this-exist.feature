@F5 @wip
Feature: Explain an entity's existence
  As a newcomer
  I want to ask why a piece of code exists
  So that I can change it without breaking hidden assumptions

  Scenario: Explain a function
    Given function "computeQuota" exists on main
    When I run "git sem why computeQuota"
    Then I see the intents of the commits that created and shaped it
    And links to the originating commits
    And the explanation cites only recorded states, not guesses

  Scenario: Insufficient history
    Given an entity was imported in a single bulk commit
    When I ask why it exists
    Then I am told the recorded intent is insufficient
    And no fabricated rationale is shown
