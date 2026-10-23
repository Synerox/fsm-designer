module wide (input clk, input rst_n, input [15:0] req, input en, output reg g);
  localparam A = 2'd0, B = 2'd1, C = 2'd2;
  reg [1:0] s, n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= A; else s <= n;
  always @* begin n = s; g = 0; case (s)
    A: if (req[0] ^ req[1] ^ req[2] ^ req[3] ^ req[4] ^ req[5] ^ req[6] ^ req[7] ^ req[8] ^ req[9] ^ req[10] ^ req[11] ^ req[12] ^ req[13] ^ req[14] ^ req[15]) n = B;
    B: begin g = 1; if (en && req[0] && req[3] && !req[7] || req[15] && en) n = C; end
    C: if (req == 16'hFFFF) n = A; else if (req[1] | req[2] | req[4] | req[8] | req[9] | req[10] | req[11] | req[12]) n = B;
  endcase end
endmodule
