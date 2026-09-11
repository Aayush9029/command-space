#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("measure_performance", Path(__file__).with_name("measure-performance.py"))
performance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(performance)


class PerformanceSamplingTests(unittest.TestCase):
    def sample(self, time, cpu, processes=("100",)):
        return {"time": time, "service_cpu_usec": cpu, "native_cpu_usec": cpu / 2, "processes": processes}

    def test_bursts_and_process_churn_do_not_count_as_settled(self):
        samples = [self.sample(0, 0), self.sample(2, 10_000), self.sample(4, 20_000), self.sample(6, 30_000)]
        self.assertTrue(performance.quiet_window(samples, 3, 5))
        samples[-1] = self.sample(6, 10_000_000)
        self.assertFalse(performance.quiet_window(samples, 3, 5))
        samples[-1] = self.sample(6, 30_000, ("100", "200"))
        self.assertFalse(performance.quiet_window(samples, 3, 5))
        self.assertFalse(performance.quiet_window(samples[:2], 3, 5))

    def test_wait_recovers_after_burst_and_remains_bounded_when_busy(self):
        for busy in [False, True]:
            now = [0]
            def sample():
                cpu = now[0] * 1_000_000 if busy or now[0] <= 2 else 2_000_000
                return self.sample(now[0], cpu)
            def sleep(seconds):
                now[0] += seconds
            result = performance.wait_for_quiet(sample, timeout=9, clock=lambda: now[0], sleep=sleep)
            self.assertEqual(result["settled"], not busy)
            self.assertEqual(result["settle_wait_seconds"], 9 if busy else 8)
            self.assertEqual(result["service_cpu_samples_percent_of_one_core"][0], 100)

    def test_cpu_counters_reject_restarts_and_separate_native_time(self):
        before, after = self.sample(2, 20_000), self.sample(4, 40_000)
        self.assertEqual(performance.cpu_percent(before, after), 1)
        self.assertEqual(performance.cpu_percent(before, after, "native_cpu_usec"), 0.5)
        with self.assertRaises(RuntimeError):
            performance.cpu_percent(after, before)
        with self.assertRaises(RuntimeError):
            performance.cpu_percent(before, self.sample(4, 0))
        with self.assertRaises(RuntimeError):
            performance.cpu_percent(before, before)

    def test_process_stat_handles_spaces_and_parentheses_in_names(self):
        fields = ["0"] * 30
        fields[11], fields[12], fields[19] = "7", "3", "1234"
        started, cpu = performance.process_cpu("10 (launcher) renamed) " + " ".join(fields))
        self.assertEqual(started, "1234")
        self.assertEqual(cpu, 10_000_000 / performance.os.sysconf("SC_CLK_TCK"))


if __name__ == "__main__":
    unittest.main()
