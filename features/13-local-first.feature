@F13 @wip
Feature: Local-first operation
  As a developer
  I want the layer to work offline on my machine
  So that I am not dependent on a remote service

  Scenario: Offline queries
    Given my machine has no network
    When I run "git sem log" or "git sem search"
    Then results come from the local index

  Scenario: Index is disposable
    Given the local index is deleted
    When I run "git sem rebuild"
    Then the index is reconstructed from "refs/notes/sem"
    And no model inference is required
