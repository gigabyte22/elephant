import os
import sys

# Make the plugin importable as the package `elephant` without a hermes checkout.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
