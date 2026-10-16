@F8 @wip
Feature: Detect semantic contradictions in clean merges
  As a reviewer
  I want to be warned when a textually clean merge is logically suspect
  So that "merges cleanly" is not mistaken for "is correct"

  Scenario: Conflicting assumptions
    Given branch A assumes "Session" is owned by the auth module
    And branch B assumes "Session" is owned by the cache module
    And the branches merge with no textual conflict
    When I run "git sem check A B"
    Then I see a warning naming both assumptions
    And the warning cites the commits that introduced them

  Scenario: Warning is non-blocking
    Given a contradiction warning was raised
    When I proceed with the merge
    Then the merge completes
    And my decision is recorded with the warning
