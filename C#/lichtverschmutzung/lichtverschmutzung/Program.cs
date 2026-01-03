using MaxRev.Gdal.Core;
using OSGeo.GDAL;
using ProjNet.CoordinateSystems;
using ProjNet.CoordinateSystems.Transformations;
using ProjNet.IO.CoordinateSystems;
using System.Net;
using System.Text.Json;
using System.Globalization;

class Program
{
    static Dataset? ds;
    static Band? band;
    static double[] geoTransform = new double[6];
    static ICoordinateTransformation? coordTransform;

    static void Main(string[] args)
    {
        GdalBase.ConfigureAll();
        LoadRaster();

        var listener = new HttpListener();
        listener.Prefixes.Add("http://localhost:8080/");
        listener.Prefixes.Add("http://127.0.0.1:8080/");
        listener.Start();

        Console.WriteLine("Server running: http://localhost:8080/");

        while (true)
        {
            var context = listener.GetContext();
            ThreadPool.QueueUserWorkItem(HandleRequest, context);
        }
    }

    static void LoadRaster()
    {
        string tiffPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "World_Atlas_2015.tif");
        ds = Gdal.Open(tiffPath, Access.GA_ReadOnly);

        if (ds == null)
        {
            Console.WriteLine("Failed to load World_Atlas_2015.tif");
            Environment.Exit(1);
        }

        band = ds.GetRasterBand(1);
        ds.GetGeoTransform(geoTransform);

        string wkt = ds.GetProjectionRef();
        CoordinateSystem? rasterSrs = null;
        if (!string.IsNullOrEmpty(wkt))
        {
            var info = CoordinateSystemWktReader.Parse(wkt);
            rasterSrs = info as CoordinateSystem;
        }
        if (rasterSrs == null)
            rasterSrs = GeographicCoordinateSystem.WGS84;

        var factory = new CoordinateTransformationFactory();
        var wgs84 = GeographicCoordinateSystem.WGS84;
        coordTransform = factory.CreateFromCoordinateSystems(wgs84, rasterSrs);
    }

    static void HandleRequest(object? state)
    {
        var context = (HttpListenerContext)state!;
        var response = context.Response;

        response.Headers.Set("Access-Control-Allow-Origin", "*");
        response.Headers.Set("Access-Control-Allow-Methods", "GET, OPTIONS");
        response.Headers.Set("Access-Control-Allow-Headers", "Content-Type");

        if (context.Request.HttpMethod == "OPTIONS")
        {
            response.StatusCode = 200;
            response.Close();
            return;
        }

        try
        {
            string path = context.Request.Url?.AbsolutePath ?? "/";

            if (path.StartsWith("/light"))
            {

                var latStr = context.Request.QueryString["lat"];
                var lngStr = context.Request.QueryString["lng"];

                if (double.TryParse(latStr, NumberStyles.Float, CultureInfo.InvariantCulture, out double lat) &&
                    double.TryParse(lngStr, NumberStyles.Float, CultureInfo.InvariantCulture, out double lng))
                {
                    var result = ProcessLocation(lat, lng);
                    SendJsonResponse(response, result);
                }
                else
                {
                    response.StatusCode = 400;
                    SendJsonResponse(response, new { error = "Invalid lat/lng" }, 400);
                }
            }
            else if (path.StartsWith("/API_EN.POP.DNST.csv"))
            {
                string csvPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "API_EN.POP.DNST.csv");
                if (File.Exists(csvPath))
                {
                    byte[] fileBytes = File.ReadAllBytes(csvPath);
                    response.ContentType = "text/csv";
                    response.ContentLength64 = fileBytes.Length;
                    response.OutputStream.Write(fileBytes, 0, fileBytes.Length);
                    response.OutputStream.Close();
                }
                else
                {
                    response.StatusCode = 404;
                    SendJsonResponse(response, new { error = "CSV file not found" }, 404);
                }
            }
            else
            {
                response.StatusCode = 404;
                SendJsonResponse(response, new { error = "Not found" }, 404);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error: {ex.Message}");
            response.StatusCode = 500;
            SendJsonResponse(response, new { error = "Internal server error" }, 500);
        }
    }


    static void SendJsonResponse(HttpListenerResponse response, object data, int statusCode = 200)
    {
        response.StatusCode = statusCode;

        var json = JsonSerializer.Serialize(data);
        byte[] buffer = System.Text.Encoding.UTF8.GetBytes(json);
        response.ContentType = "application/json";
        response.ContentLength64 = buffer.Length;
        response.OutputStream.Write(buffer, 0, buffer.Length);
        response.OutputStream.Close();
    }

    static object ProcessLocation(double lat, double lng)
    {
        double raw = GetPixelValue(lat, lng);
        string sqm = ArtificialToSqmScaled(raw);
        double bortle = EstimateBortleFractional(sqm);
        return new { latitude = lat, longitude = lng, raw_value = raw, sqm, bortle };
    }

    static double GetPixelValue(double lat, double lng)
    {
        if (ds == null || band == null || coordTransform == null) return 0;

        try
        {
            double[] xy = coordTransform.MathTransform.Transform(new[] { lng, lat });
            int col = (int)((xy[0] - geoTransform[0]) / geoTransform[1]);
            int row = (int)((xy[1] - geoTransform[3]) / geoTransform[5]);

            if (col < 0 || row < 0 || col >= ds.RasterXSize || row >= ds.RasterYSize)
                return 0;

            float[] buffer = new float[1];
            band.ReadRaster(col, row, 1, 1, buffer, 1, 1, 0, 0);
            return buffer[0];
        }
        catch
        {
            return 0;
        }
    }

    static string ArtificialToSqmScaled(double rawValue)
    {
        if (rawValue <= 0) return "22.00";
        double rawCapped = Math.Min(rawValue, 10.0);
        double baseRawDark = 0.1000683605670929;
        double baseSqmDark = 21.28;
        double sqmDark = baseSqmDark - 5 * (rawCapped - baseRawDark);
        double sqm = Math.Max(sqmDark, 17.70 - 0.5 * (rawCapped - 2.0));
        return sqm.ToString("0.00", CultureInfo.InvariantCulture);
    }

    static double EstimateBortleFractional(string sqmString)
    {
        if (!double.TryParse(sqmString, NumberStyles.Float, CultureInfo.InvariantCulture, out double sqm))
            return 9.0;

        double bortle;

        if (sqm >= 21.99)
            bortle = 1.0;
        else if (sqm >= 21.70)
            bortle = 2.0;
        else if (sqm >= 21.30)
            bortle = 3.0;
        else if (sqm >= 21.00)
            bortle = 4.0 + ((21.30 - sqm) / 0.30) * 0.7;     
        else if (sqm >= 20.49)
            bortle = 4.8;
        else if (sqm >= 19.50)
            bortle = 5.5;
        else if (sqm >= 18.50)
            bortle = 6.5;
        else if (sqm >= 17.70)
            bortle = 7.0 + ((18.00 - sqm) / 0.30) * 2.0;    
        else
            bortle = 9.0;

        return Math.Round(Math.Clamp(bortle, 1.0, 9.0), 1);
    }
}
