@F17
Feature: Share only what cannot be recomputed
  As a team
  I want the shared notes to hold intents and decisions, not caches
  So that we push judgment and model time, not data anyone can rebuild

  Scenario: Recomputable records stay local
    Given a git repository with the semantic layer initialized
    And background indexing is disabled
    And I commit "src/user.ts" with a function "loadUser"
    And I run "git sem index"
    Then the shared notes hold no recomputable records
    And the local notes hold "changes", "file", "entities" and "entity-events" records
    When the semantic engine is the test engine with model "m1"
    And I run "git sem index --rev HEAD"
    Then the shared notes hold only intents from model "m1"
    And the commit "Add loadUser" has an intent from model "m1"

  Scenario: Teams can still share everything
    Given a git repository with the semantic layer initialized
    And background indexing is disabled
    And sharing is set to "derived"
    And I commit "src/user.ts" with a function "loadUser"
    When I run "git sem index"
    Then the shared notes hold "changes" and "entity-events" records

  Scenario: Prune cleans notes written by an older git-sem
    Given a git repository with the semantic layer initialized
    And background indexing is disabled
    And sharing is set to "derived"
    And I commit "src/user.ts" with a function "loadUser"
    And I run "git sem index"
    And the semantic engine is the test engine with model "m1"
    And I run "git sem index --rev HEAD"
    And the shared notes also hold an "entity-events" record from "entities/v2" for HEAD
    And sharing is set to "recomputable"
    When I run "git sem prune"
    Then the shared notes hold only intents from model "m1"
    And no notes hold "entity-events" records from "entities/v2"
    And no notes hold a heuristic intent for HEAD
    And the local notes hold "changes", "file", "entities" and "entity-events" records
    And the commit "Add loadUser" has an intent from model "m1"
    When I run "git sem entity loadUser"
    Then the lineage of "loadUser" reads "added"

  Scenario: Pruned records do not come back through a push
    Given a shared remote "origin"
    And "alice" has cloned "origin" with the semantic layer initialized
    And "bob" has cloned "origin" with the semantic layer initialized
    And background indexing is disabled for all teammates
    And I am "alice"
    And sharing is set to "derived"
    And I commit "src/user.ts" with a function "loadUser"
    And I run "git sem index"
    And I run "git push --quiet origin HEAD:main"
    And I run "git sem push origin"
    And the shared notes on "origin" hold recomputable records
    When I am "bob"
    And the semantic engine is the test engine with model "m1"
    And I run "git pull --quiet origin main"
    And I run "git sem index"
    And I run "git sem push origin"
    Then the shared notes on "origin" hold no recomputable records
    And the shared notes on "origin" hold an intent from model "m1"

  Scenario: A fresh clone rebuilds local records without a model
    Given a shared remote "origin"
    And "alice" has cloned "origin" with the semantic layer initialized
    And "bob" has cloned "origin" with the semantic layer initialized
    And background indexing is disabled for all teammates
    And I am "alice"
    And the semantic engine is the test engine with model "m1"
    And I commit "src/user.ts" with a function "loadUser"
    And I run "git sem index --all"
    And I run "git push --quiet origin HEAD:main"
    And I run "git sem push origin"
    When I am "bob"
    And the semantic engine is the test engine with model "m1"
    And I run "git pull --quiet origin main"
    And I run "git sem fetch origin"
    And I run "git sem entity loadUser"
    Then the lineage of "loadUser" reads "added"
    When I run "git sem index --all"
    Then the engine has not been invoked
    And the local notes hold "changes", "file", "entities" and "entity-events" records

  Scenario: Squashing the shared notes is explicit and guarded
    Given a shared remote "origin"
    And "alice" has cloned "origin" with the semantic layer initialized
    And "bob" has cloned "origin" with the semantic layer initialized
    And background indexing is disabled for all teammates
    And I am "alice"
    And the semantic engine is the test engine with model "m1"
    And I commit a change to "a.ts" with message "one"
    And I run "git sem index"
    And I commit a change to "b.ts" with message "two"
    And I run "git sem index"
    And I run "git push --quiet origin HEAD:main"
    And I run "git sem push origin"
    When I run "git sem prune --squash"
    Then the shared notes have 1 commit of history
    When I run "git sem push origin --force-with-lease"
    Then the shared notes on "origin" are the same as mine
    When I am "bob"
    And I run "git sem fetch origin --reset"
    Then the shared notes have 1 commit of history

  Scenario: A squash cannot discard a teammate's push
    Given a shared remote "origin"
    And "alice" has cloned "origin" with the semantic layer initialized
    And "bob" has cloned "origin" with the semantic layer initialized
    And background indexing is disabled for all teammates
    And I am "alice"
    And the semantic engine is the test engine with model "m1"
    And I commit a change to "a.ts" with message "one"
    And I run "git sem index"
    And I run "git push --quiet origin HEAD:main"
    And I run "git sem push origin"
    And I am "bob"
    And the semantic engine is the test engine with model "m2"
    And I run "git pull --quiet origin main"
    And I run "git sem index --rev HEAD"
    And I run "git sem push origin"
    And I am "alice"
    And I run "git sem prune --squash"
    When I try to run "git sem push origin --force-with-lease"
    Then it fails with a message containing "changed since your last fetch"
    And the shared notes on "origin" hold an intent from model "m2"
