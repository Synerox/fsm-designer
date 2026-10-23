module oh (input clk, input rst_n, input go, input back, output reg act);
  localparam B0 = 0, B1 = 1, B2 = 2, B3 = 3, B4 = 4, B5 = 5, B6 = 6, B7 = 7;
  reg [7:0] st, nx;
  always @(posedge clk or negedge rst_n) if (!rst_n) st <= 8'b1; else st <= nx;
  always @* begin nx = 8'b0; act = 0; case (1'b1)
    st[B0]: begin if (go) nx[B1] = 1'b1; else if (back) nx[B7] = 1'b1; else nx[B0] = 1'b1; end
    st[B1]: begin act = 1; if (go) nx[B2] = 1'b1; else if (back) nx[B0] = 1'b1; else nx[B1] = 1'b1; end
    st[B2]: begin if (go) nx[B3] = 1'b1; else if (back) nx[B1] = 1'b1; else nx[B2] = 1'b1; end
    st[B3]: begin act = 1; if (go) nx[B4] = 1'b1; else if (back) nx[B2] = 1'b1; else nx[B3] = 1'b1; end
    st[B4]: begin if (go) nx[B5] = 1'b1; else if (back) nx[B3] = 1'b1; else nx[B4] = 1'b1; end
    st[B5]: begin act = 1; if (go) nx[B6] = 1'b1; else if (back) nx[B4] = 1'b1; else nx[B5] = 1'b1; end
    st[B6]: begin if (go) nx[B7] = 1'b1; else if (back) nx[B5] = 1'b1; else nx[B6] = 1'b1; end
    st[B7]: begin act = 1; if (go) nx[B0] = 1'b1; else if (back) nx[B6] = 1'b1; else nx[B7] = 1'b1; end
  endcase end
endmodule
