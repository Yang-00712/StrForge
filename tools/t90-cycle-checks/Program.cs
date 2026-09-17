using System.Security.Cryptography;
using StrForge.App.Services;

var checks = 0;
void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
    checks++;
    Console.WriteLine("PASS " + message);
}
int[] Draw(T90ValueGenerator generator, string low, string high)
{
    if (!generator.TryGenerate(low, high, out var values, out var error)) throw new InvalidOperationException(error);
    return values;
}
var rng = new BoundaryRandom(false);
var generator = new T90ValueGenerator(rng);
foreach (var (low, high) in new (string?,string?)[] { (null,"100"),("0",null),("","100"),("x","100"),("1.5","100"),("-1","100"),("100","0"),("0","2147483648"),("0","0"),("985","995"),("0","13"),("2147483647","2147483647") })
    Check(!generator.TryGenerate(low, high, out var values, out var error) && values.Length == 0 && error.Length > 0 && rng.Calls == 0 && generator.RememberedValueCount == 0, "Reject invalid/insufficient range: " + low + "," + high);
for (var cycle=0;cycle<3;cycle++)
{
    var values=new List<int>();
    for(var roll=1;roll<=5;roll++)
    {
        values.AddRange(Draw(generator,"981","995"));
        Check(generator.LastRollNumber==roll && generator.RememberedValueCount==(roll==5?0:roll*3), $"Cycle {cycle+1}, roll {roll}: correct history lifetime");
    }
    Check(values.SequenceEqual(Enumerable.Range(981,15)), "Minimum range covers all 15 values once");
}
var maximum=new T90ValueGenerator(new BoundaryRandom(true));
var highValues=Enumerable.Range(0,5).SelectMany(_=>Draw(maximum,"0","2147483647")).ToArray();
Check(highValues.SequenceEqual(Enumerable.Range(0,15).Select(n=>int.MaxValue-n)), "Full Int32 range has no overflow or max-value saturation");
Check(maximum.RememberedValueCount==0 && maximum.LastRollNumber==5, "Fifth draw releases numeric history immediately");
Check(Draw(maximum,"0","2147483647")[0]==int.MaxValue && maximum.LastRollNumber==1, "Sixth draw begins a new independent block");
var nearMaximum=new T90ValueGenerator(new BoundaryRandom(false));
var near=Enumerable.Range(0,5).SelectMany(_=>Draw(nearMaximum,"2147483633","2147483647")).ToArray();
Check(near.Distinct().Count()==15 && near.Min()==2147483633 && near.Max()==int.MaxValue, "Minimum range at Int32 maximum includes both boundaries");
var mapped=new List<int>();
for(var rank=0;rank<12;rank++)
{
    var g=new T90ValueGenerator(new ScriptedRandom(0,7,12,rank,0,0));
    Check(Draw(g,"0","14").SequenceEqual(new[]{0,8,14}), "Establish exact used values for rank test");
    mapped.Add(Draw(g,"0","14")[0]);
}
Check(mapped.SequenceEqual(Enumerable.Range(0,15).Except(new[]{0,8,14})), "Unused-rank mapping is bijective; no clamping/modulo bias");
generator.ResetCycle();
Draw(generator,"100","114");var before=rng.Calls;
Check(!generator.TryGenerate("985","995",out _,out _) && generator.LastRollNumber==1 && generator.RememberedValueCount==3 && rng.Calls==before,"Invalid attempt preserves active cycle and RNG state");
Check(Draw(generator," 100 ","114").SequenceEqual(new[]{103,104,105}) && generator.LastRollNumber==2,"Same parsed range keeps memory");
Check(Draw(generator,"200","214").SequenceEqual(new[]{200,201,202}) && generator.LastRollNumber==1,"Changed valid range resets memory");
generator.ResetCycle();
Check(generator.LastRollNumber==0 && generator.RememberedValueCount==0,"Explicit clear releases cycle state");
Check(Draw(generator,"200","214").SequenceEqual(new[]{200,201,202}),"Reset generator remains usable");
Check(Draw(new T90ValueGenerator(new BoundaryRandom(false)),"200","214").SequenceEqual(new[]{200,201,202}),"History is per instance, never global");
var stress=new T90ValueGenerator(new Random(712));var valid=true;
for(var cycle=0;cycle<10000;cycle++)
{
    var low=cycle%2==0?0:int.MaxValue-20;var high=low+20;var seen=new HashSet<int>();
    for(var roll=1;roll<=5;roll++)
    {
        var values=Draw(stress,low.ToString(),high.ToString());
        valid &= values.Length==3 && values.All(v=>v>=low && v<=high && seen.Add(v));
        valid &= stress.LastRollNumber==roll && stress.RememberedValueCount==(roll==5?0:roll*3);
    }
    valid &= seen.Count==15 && seen.Count(v=>v==high)<=1;
}
Check(valid,"10,000 cycles / 50,000 rolls / 150,000 values: unique, in-range and bounded-memory");
Console.WriteLine($"RESULT checks={checks} failures=0");
var source=Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"..","..","..","T90ValueGenerator.cs"));
Console.WriteLine("SOURCE_SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(source))).ToLowerInvariant());

sealed class BoundaryRandom(bool maximum):Random
{
    public int Calls {get;private set;}
    public override long NextInt64(long minValue,long maxValue)
    {
        Calls++;if(minValue>=maxValue)throw new InvalidOperationException("empty random interval");
        return maximum?maxValue-1:minValue;
    }
}
sealed class ScriptedRandom(params long[] values):Random
{
    private readonly Queue<long> ranks=new(values);
    public override long NextInt64(long minValue,long maxValue)
    {
        var value=ranks.Dequeue();if(value<minValue || value>=maxValue)throw new InvalidOperationException("invalid scripted rank");return value;
    }
}
