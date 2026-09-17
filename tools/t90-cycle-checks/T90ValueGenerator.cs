using System;
using System.Collections.Generic;
using System.Globalization;

namespace StrForge.App.Services;

/// <summary>
/// Draws three distinct integers per roll without replacement over a five-roll cycle.
/// History is transient, bounded to fifteen integers, and never serialized.
/// </summary>
public sealed class T90ValueGenerator
{
    public const int RollsPerCycle = 5;
    public const int ValuesPerRoll = 3;
    public const int ValuesPerCycle = RollsPerCycle * ValuesPerRoll;

    private readonly Random _random;
    private readonly List<int> _usedValues = new(ValuesPerCycle);
    private int _rollsInCycle;
    private int? _cycleLower;
    private int? _cycleUpper;

    public int LastRollNumber { get; private set; }
    public int RememberedValueCount => _usedValues.Count;

    public T90ValueGenerator(Random? random = null) => _random = random ?? Random.Shared;

    public void ResetCycle()
    {
        _usedValues.Clear();
        _rollsInCycle = 0;
        LastRollNumber = 0;
        _cycleLower = _cycleUpper = null;
    }

    public bool TryGenerate(string? lowerText, string? upperText, out int[] values, out string error)
    {
        values = Array.Empty<int>();
        if (!int.TryParse(lowerText?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var lower) ||
            !int.TryParse(upperText?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var upper) ||
            lower < 0 || upper < 0)
        {
            error = "骰子起始與骰子結束請輸入 0 至 2147483647 的整數。";
            return false;
        }
        if (lower > upper)
        {
            error = "骰子起始不能大於骰子結束；原本三格數值已保留。";
            return false;
        }

        // long keeps the inclusive full Int32 range from overflowing.
        var rangeSize = (long)upper - lower + 1;
        if (rangeSize < ValuesPerCycle)
        {
            error = $"五次共 15 個數值不重複，需要至少 15 個整數；目前只有 {rangeSize} 個。請調整骰子起始或骰子結束；原本三格數值已保留。";
            return false;
        }

        // Work on a bounded copy. No partial history or input changes on a failed roll.
        var sameRange = _cycleLower == lower && _cycleUpper == upper;
        var used = sameRange ? new List<int>(_usedValues) : new List<int>(ValuesPerCycle);
        var rollNumber = (sameRange ? _rollsInCycle : 0) + 1;
        var generated = new int[ValuesPerRoll];
        for (var index = 0; index < generated.Length; index++)
        {
            // Sample a rank among unused integers, then skip the sorted used values.
            // This is a one-to-one mapping, not clamping, modulo, or a retry-until-unique loop.
            // At most 14 exclusions are inspected; the full range is never allocated.
            var rank = _random.NextInt64(0, rangeSize - used.Count);
            var candidate = (long)lower + rank;
            foreach (var previous in used)
            {
                if (previous > candidate) break;
                candidate++;
            }
            var value = checked((int)candidate);
            used.Insert(~used.BinarySearch(value), value);
            generated[index] = value;
        }

        _cycleLower = lower;
        _cycleUpper = upper;
        LastRollNumber = rollNumber;
        _usedValues.Clear();
        if (rollNumber == RollsPerCycle)
        {
            _rollsInCycle = 0;
            // LastRollNumber keeps the "5/5" status; all drawn-number history is released.
        }
        else
        {
            _rollsInCycle = rollNumber;
            _usedValues.AddRange(used);
        }
        values = generated;
        error = "";
        return true;
    }
}
