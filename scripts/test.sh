#!/bin/bash
set -e

# VeriLink Test Runner
# Runs all unit and integration tests across the repository.

echo "--- VeriLink: Running All Tests ---"

# Use the standard Go test runner for the entire module
go test ./... -v

echo "--- VeriLink: All Tests Complete ---"
