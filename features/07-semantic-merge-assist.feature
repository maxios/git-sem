@F7 @wip
Feature: Semantic merge assistance
  As a developer merging two worlds
  I want the meaning of each side made legible
  So that I can decide quickly and correctly

  Scenario: Compare only co-touched entities
    Given branches A and B both touched entities "Quota" and "Retry"
    When I run "git sem merge-view A B"
    Then I see only "Quota" and "Retry"
    And each shows the intent from A and the intent from B

  Scenario: Redundant changes are identified
    Given A and B both fixed the same timeout in different ways
    When I view the merge
    Then the layer flags the changes as "likely redundant"
    And the final choice is left to me

  Scenario: The layer never auto-resolves
    Given a textual conflict exists
    When the layer proposes a resolution
    Then the proposal is shown as a suggestion only
    And nothing is written until I accept it
