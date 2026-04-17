use js_sys::Float32Array;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const MAX_TRIANGLES: u32 = 5_000_000;

#[wasm_bindgen]
pub struct Mesh {
    positions: Vec<f32>,
    normals: Vec<f32>,
    triangle_count: u32,
    bbox: [f32; 6],
    watertight: bool,
    boundary_edges: u32,
    non_manifold_edges: u32,
    degenerate_triangles: u32,
    boundary_positions: Vec<f32>,
    non_manifold_positions: Vec<f32>,
    volume: f32,
}

#[wasm_bindgen]
impl Mesh {
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> Float32Array {
        Float32Array::from(&self.positions[..])
    }

    #[wasm_bindgen(getter)]
    pub fn normals(&self) -> Float32Array {
        Float32Array::from(&self.normals[..])
    }

    #[wasm_bindgen(getter, js_name = triangleCount)]
    pub fn triangle_count(&self) -> u32 {
        self.triangle_count
    }

    #[wasm_bindgen(getter)]
    pub fn bbox(&self) -> Float32Array {
        Float32Array::from(&self.bbox[..])
    }

    #[wasm_bindgen(getter, js_name = isWatertight)]
    pub fn is_watertight(&self) -> bool {
        self.watertight
    }

    #[wasm_bindgen(getter, js_name = boundaryEdges)]
    pub fn boundary_edges(&self) -> u32 {
        self.boundary_edges
    }

    #[wasm_bindgen(getter, js_name = nonManifoldEdges)]
    pub fn non_manifold_edges(&self) -> u32 {
        self.non_manifold_edges
    }

    #[wasm_bindgen(getter, js_name = degenerateTriangles)]
    pub fn degenerate_triangles(&self) -> u32 {
        self.degenerate_triangles
    }

    #[wasm_bindgen(getter, js_name = boundaryEdgePositions)]
    pub fn boundary_edge_positions(&self) -> Float32Array {
        Float32Array::from(&self.boundary_positions[..])
    }

    #[wasm_bindgen(getter, js_name = nonManifoldEdgePositions)]
    pub fn non_manifold_edge_positions(&self) -> Float32Array {
        Float32Array::from(&self.non_manifold_positions[..])
    }

    #[wasm_bindgen(getter)]
    pub fn volume(&self) -> f32 {
        self.volume
    }
}

fn compute_volume(positions: &[f32]) -> f32 {
    // Signed tetrahedral volume sum. Accurate for closed meshes; still a
    // useful approximation for non-watertight ones. Accumulated in f64 to
    // avoid catastrophic cancellation on meshes far from the origin.
    let tcount = positions.len() / 9;
    let mut acc: f64 = 0.0;
    for t in 0..tcount {
        let i = t * 9;
        let x0 = positions[i] as f64;
        let y0 = positions[i + 1] as f64;
        let z0 = positions[i + 2] as f64;
        let x1 = positions[i + 3] as f64;
        let y1 = positions[i + 4] as f64;
        let z1 = positions[i + 5] as f64;
        let x2 = positions[i + 6] as f64;
        let y2 = positions[i + 7] as f64;
        let z2 = positions[i + 8] as f64;
        acc += x0 * (y1 * z2 - z1 * y2)
             - y0 * (x1 * z2 - z1 * x2)
             + z0 * (x1 * y2 - y1 * x2);
    }
    (acc.abs() / 6.0) as f32
}

#[wasm_bindgen]
pub fn parse_stl(data: &[u8]) -> Result<Mesh, JsValue> {
    if data.len() < 15 {
        return Err(JsValue::from_str("file too small for STL"));
    }

    if is_ascii_stl(data) {
        parse_ascii(data)
    } else if data.len() >= 84 {
        parse_binary(data)
    } else {
        Err(JsValue::from_str("file too small for binary STL"))
    }
}

fn is_ascii_stl(data: &[u8]) -> bool {
    // Mirrors three.js STLLoader isBinary logic:
    //   1. If expected binary size matches → binary.
    //   2. Doesn't start with "solid" → binary.
    //   3. Contains control chars that only appear in binary → binary.
    //   4. Otherwise ASCII.
    if data.len() >= 84 {
        let tri_count = u32::from_le_bytes([data[80], data[81], data[82], data[83]]);
        // u64 math so wasm32 usize overflow on noise bytes can't panic.
        let expected = 84u64 + (tri_count as u64) * 50;
        if expected == data.len() as u64 {
            return false;
        }
    }

    if data.len() < 5 || &data[..5] != b"solid" {
        return false;
    }

    let scan_end = data.len().min(2048);
    for &b in &data[5..scan_end] {
        if b < 0x09 || (b > 0x0D && b < 0x20) {
            return false;
        }
    }
    true
}

fn parse_binary(data: &[u8]) -> Result<Mesh, JsValue> {
    let tri_count = u32::from_le_bytes([data[80], data[81], data[82], data[83]]);
    if tri_count > MAX_TRIANGLES {
        return Err(JsValue::from_str("triangle count exceeds limit"));
    }
    let expected = 84usize + (tri_count as usize) * 50;
    if data.len() < expected {
        return Err(JsValue::from_str("binary STL is truncated"));
    }

    let n = tri_count as usize;
    let mut positions = Vec::with_capacity(n * 9);
    let mut normals = Vec::with_capacity(n * 9);
    let mut bbox = BBox::new();

    let mut off = 84;
    for _ in 0..n {
        let nx = f32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
        let ny = f32::from_le_bytes([data[off + 4], data[off + 5], data[off + 6], data[off + 7]]);
        let nz = f32::from_le_bytes([data[off + 8], data[off + 9], data[off + 10], data[off + 11]]);
        let mut vs = [[0f32; 3]; 3];
        for v in 0..3 {
            let base = off + 12 + v * 12;
            vs[v][0] = f32::from_le_bytes([data[base], data[base + 1], data[base + 2], data[base + 3]]);
            vs[v][1] = f32::from_le_bytes([data[base + 4], data[base + 5], data[base + 6], data[base + 7]]);
            vs[v][2] = f32::from_le_bytes([data[base + 8], data[base + 9], data[base + 10], data[base + 11]]);
        }

        let (nx, ny, nz) = if nx == 0.0 && ny == 0.0 && nz == 0.0 {
            compute_normal(&vs)
        } else {
            (nx, ny, nz)
        };

        for v in 0..3 {
            positions.push(vs[v][0]);
            positions.push(vs[v][1]);
            positions.push(vs[v][2]);
            normals.push(nx);
            normals.push(ny);
            normals.push(nz);
            bbox.add(vs[v][0], vs[v][1], vs[v][2]);
        }
        off += 50;
    }

    let bbox_arr = bbox.to_array();
    let analysis = analyze_mesh(&positions, &bbox_arr);
    let volume = compute_volume(&positions);
    Ok(Mesh {
        positions,
        normals,
        triangle_count: tri_count,
        bbox: bbox_arr,
        watertight: analysis.watertight,
        boundary_edges: analysis.boundary_edges,
        non_manifold_edges: analysis.non_manifold_edges,
        degenerate_triangles: analysis.degenerate_triangles,
        boundary_positions: analysis.boundary_positions,
        non_manifold_positions: analysis.non_manifold_positions,
        volume,
    })
}

fn parse_ascii(data: &[u8]) -> Result<Mesh, JsValue> {
    let text = std::str::from_utf8(data).map_err(|_| JsValue::from_str("ascii STL not valid UTF-8"))?;

    let mut positions: Vec<f32> = Vec::new();
    let mut normals: Vec<f32> = Vec::new();
    let mut bbox = BBox::new();
    let mut triangle_count: u32 = 0;

    let mut current_normal = [0f32; 3];
    let mut current_verts: Vec<[f32; 3]> = Vec::with_capacity(3);
    let mut in_facet = false;

    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(rest) = t.strip_prefix("facet normal ") {
            current_normal = parse_three_floats(rest)?;
            current_verts.clear();
            in_facet = true;
        } else if in_facet {
            if let Some(rest) = t.strip_prefix("vertex ") {
                let v = parse_three_floats(rest)?;
                current_verts.push(v);
            } else if t == "endfacet" {
                if current_verts.len() != 3 {
                    return Err(JsValue::from_str("ascii STL facet with wrong vertex count"));
                }
                let (nx, ny, nz) = if current_normal == [0.0, 0.0, 0.0] {
                    compute_normal(&[current_verts[0], current_verts[1], current_verts[2]])
                } else {
                    (current_normal[0], current_normal[1], current_normal[2])
                };
                for v in &current_verts {
                    positions.push(v[0]);
                    positions.push(v[1]);
                    positions.push(v[2]);
                    normals.push(nx);
                    normals.push(ny);
                    normals.push(nz);
                    bbox.add(v[0], v[1], v[2]);
                }
                triangle_count += 1;
                if triangle_count > MAX_TRIANGLES {
                    return Err(JsValue::from_str("triangle count exceeds limit"));
                }
                in_facet = false;
                current_verts.clear();
            }
        }
    }

    let bbox_arr = bbox.to_array();
    let analysis = analyze_mesh(&positions, &bbox_arr);
    let volume = compute_volume(&positions);
    Ok(Mesh {
        positions,
        normals,
        triangle_count,
        bbox: bbox_arr,
        watertight: analysis.watertight,
        boundary_edges: analysis.boundary_edges,
        non_manifold_edges: analysis.non_manifold_edges,
        degenerate_triangles: analysis.degenerate_triangles,
        boundary_positions: analysis.boundary_positions,
        non_manifold_positions: analysis.non_manifold_positions,
        volume,
    })
}

struct Analysis {
    watertight: bool,
    boundary_edges: u32,
    non_manifold_edges: u32,
    degenerate_triangles: u32,
    boundary_positions: Vec<f32>,
    non_manifold_positions: Vec<f32>,
}

// Cap emitted edge-overlay vertices so a pathological mesh (millions of
// boundary edges) can't inflate the WASM return into the megabytes.
const MAX_OVERLAY_EDGES: u32 = 100_000;

fn analyze_mesh(positions: &[f32], bbox: &[f32; 6]) -> Analysis {
    let vcount = positions.len() / 3;
    let tcount = vcount / 3;
    if tcount == 0 {
        return Analysis {
            watertight: false,
            boundary_edges: 0,
            non_manifold_edges: 0,
            degenerate_triangles: 0,
            boundary_positions: Vec::new(),
            non_manifold_positions: Vec::new(),
        };
    }

    // Quantization grid: ε relative to bbox diagonal, clamped so we don't
    // collapse genuine detail on tiny models or go below f32 precision on huge ones.
    let dx = (bbox[3] - bbox[0]) as f64;
    let dy = (bbox[4] - bbox[1]) as f64;
    let dz = (bbox[5] - bbox[2]) as f64;
    let diag = (dx * dx + dy * dy + dz * dz).sqrt();
    let eps = (diag * 1e-6).max(1e-7);
    let inv_eps = 1.0 / eps;

    let mut vertex_id: HashMap<(i64, i64, i64), u32> = HashMap::with_capacity(vcount / 2 + 1);
    let mut unique_positions: Vec<[f32; 3]> = Vec::new();
    let mut indices: Vec<u32> = Vec::with_capacity(vcount);

    for v in 0..vcount {
        let x = positions[v * 3];
        let y = positions[v * 3 + 1];
        let z = positions[v * 3 + 2];
        let key = (
            (x as f64 * inv_eps).round() as i64,
            (y as f64 * inv_eps).round() as i64,
            (z as f64 * inv_eps).round() as i64,
        );
        let id = match vertex_id.get(&key) {
            Some(&id) => id,
            None => {
                let id = unique_positions.len() as u32;
                unique_positions.push([x, y, z]);
                vertex_id.insert(key, id);
                id
            }
        };
        indices.push(id);
    }

    let mut edges: HashMap<(u32, u32), u32> = HashMap::with_capacity(tcount * 3 / 2 + 1);
    let mut degenerate: u32 = 0;

    for t in 0..tcount {
        let a = indices[t * 3];
        let b = indices[t * 3 + 1];
        let c = indices[t * 3 + 2];
        if a == b || b == c || a == c {
            degenerate += 1;
            continue;
        }
        for (u, v) in [(a, b), (b, c), (c, a)] {
            let key = if u < v { (u, v) } else { (v, u) };
            *edges.entry(key).or_insert(0) += 1;
        }
    }

    let mut boundary: u32 = 0;
    let mut non_manifold: u32 = 0;
    let mut boundary_positions: Vec<f32> = Vec::new();
    let mut non_manifold_positions: Vec<f32> = Vec::new();

    for (&(a, b), &cnt) in edges.iter() {
        match cnt {
            1 => {
                boundary += 1;
                if boundary <= MAX_OVERLAY_EDGES {
                    let va = unique_positions[a as usize];
                    let vb = unique_positions[b as usize];
                    boundary_positions.extend_from_slice(&[va[0], va[1], va[2], vb[0], vb[1], vb[2]]);
                }
            }
            2 => {}
            _ => {
                non_manifold += 1;
                if non_manifold <= MAX_OVERLAY_EDGES {
                    let va = unique_positions[a as usize];
                    let vb = unique_positions[b as usize];
                    non_manifold_positions.extend_from_slice(&[va[0], va[1], va[2], vb[0], vb[1], vb[2]]);
                }
            }
        }
    }

    Analysis {
        watertight: boundary == 0 && non_manifold == 0,
        boundary_edges: boundary,
        non_manifold_edges: non_manifold,
        degenerate_triangles: degenerate,
        boundary_positions,
        non_manifold_positions,
    }
}

fn parse_three_floats(s: &str) -> Result<[f32; 3], JsValue> {
    let mut it = s.split_whitespace();
    let a: f32 = it.next().ok_or_else(|| JsValue::from_str("missing float"))?.parse().map_err(|_| JsValue::from_str("bad float"))?;
    let b: f32 = it.next().ok_or_else(|| JsValue::from_str("missing float"))?.parse().map_err(|_| JsValue::from_str("bad float"))?;
    let c: f32 = it.next().ok_or_else(|| JsValue::from_str("missing float"))?.parse().map_err(|_| JsValue::from_str("bad float"))?;
    Ok([a, b, c])
}

fn compute_normal(v: &[[f32; 3]; 3]) -> (f32, f32, f32) {
    let ax = v[1][0] - v[0][0];
    let ay = v[1][1] - v[0][1];
    let az = v[1][2] - v[0][2];
    let bx = v[2][0] - v[0][0];
    let by = v[2][1] - v[0][1];
    let bz = v[2][2] - v[0][2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    let len = (nx * nx + ny * ny + nz * nz).sqrt();
    if len > 0.0 {
        (nx / len, ny / len, nz / len)
    } else {
        (0.0, 0.0, 1.0)
    }
}

struct BBox {
    min: [f32; 3],
    max: [f32; 3],
    has_data: bool,
}

impl BBox {
    fn new() -> Self {
        BBox {
            min: [0.0, 0.0, 0.0],
            max: [0.0, 0.0, 0.0],
            has_data: false,
        }
    }
    fn add(&mut self, x: f32, y: f32, z: f32) {
        if !self.has_data {
            self.min = [x, y, z];
            self.max = [x, y, z];
            self.has_data = true;
            return;
        }
        if x < self.min[0] { self.min[0] = x; }
        if y < self.min[1] { self.min[1] = y; }
        if z < self.min[2] { self.min[2] = z; }
        if x > self.max[0] { self.max[0] = x; }
        if y > self.max[1] { self.max[1] = y; }
        if z > self.max[2] { self.max[2] = z; }
    }
    fn to_array(&self) -> [f32; 6] {
        [
            self.min[0], self.min[1], self.min[2],
            self.max[0], self.max[1], self.max[2],
        ]
    }
}
