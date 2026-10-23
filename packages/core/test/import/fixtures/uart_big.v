// A realistic UART transmitter + receiver in one big module, with a FIFO,
// baud generator, parity, generate loops, functions, tasks and a submodule.
`timescale 1ns/1ps
module sync2 #(parameter W = 1) (input clk, input [W-1:0] d, output reg [W-1:0] q);
  reg [W-1:0] m;
  always @(posedge clk) begin m <= d; q <= m; end
endmodule

module uart_top #(
  parameter CLK_HZ = 50_000_000,
  parameter BAUD   = 115200,
  parameter DEPTH  = 16
)(
  input  wire       clk,
  input  wire       rst_n,
  input  wire       wr_en,
  input  wire [7:0] wr_data,
  input  wire       parity_en,
  input  wire       rx_pin,
  output reg        tx_pin,
  output wire       tx_busy,
  output reg  [7:0] rx_data,
  output reg        rx_valid,
  output reg        rx_err
);
  localparam integer DIV = CLK_HZ / BAUD;
  localparam integer AW  = $clog2(DEPTH);

  // ---------------- FIFO ----------------
  reg [7:0] mem [0:DEPTH-1];
  reg [AW:0] wp, rp;
  wire empty = (wp == rp);
  wire full  = (wp[AW-1:0] == rp[AW-1:0]) && (wp[AW] != rp[AW]);
  integer i;
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      wp <= 0;
      for (i = 0; i < DEPTH; i = i + 1) mem[i] <= 8'h00;
    end else if (wr_en && !full) begin
      mem[wp[AW-1:0]] <= wr_data;
      wp <= wp + 1'b1;
    end
  end

  function automatic parity8(input [7:0] v);
    parity8 = ^v;
  endfunction

  // ---------------- baud tick ----------------
  reg [15:0] bcnt;
  wire tick = (bcnt == DIV - 1);
  always @(posedge clk or negedge rst_n)
    if (!rst_n) bcnt <= 0;
    else bcnt <= tick ? 16'd0 : bcnt + 16'd1;

  // ---------------- TX FSM ----------------
  localparam [2:0] TX_IDLE = 3'd0, TX_START = 3'd1, TX_DATA = 3'd2, TX_PAR = 3'd3, TX_STOP = 3'd4;
  reg [2:0] tx_state, tx_next;
  reg [2:0] bit_idx;
  reg [7:0] shreg;

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) tx_state <= TX_IDLE;
    else        tx_state <= tx_next;
  end

  always @(*) begin
    tx_next = tx_state;
    case (tx_state)
      TX_IDLE:  if (!empty && tick) tx_next = TX_START;
      TX_START: if (tick) tx_next = TX_DATA;
      TX_DATA:  if (tick && bit_idx == 3'd7) tx_next = parity_en ? TX_PAR : TX_STOP;
      TX_PAR:   if (tick) tx_next = TX_STOP;
      TX_STOP:  if (tick) tx_next = TX_IDLE;
      default:  tx_next = TX_IDLE;
    endcase
  end

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      rp <= 0; bit_idx <= 0; shreg <= 0;
    end else if (tick) begin
      case (tx_state)
        TX_IDLE:  if (!empty) begin shreg <= mem[rp[AW-1:0]]; rp <= rp + 1'b1; end
        TX_DATA:  begin shreg <= {1'b0, shreg[7:1]}; bit_idx <= bit_idx + 3'd1; end
        default:  bit_idx <= 3'd0;
      endcase
    end
  end

  always @(*) begin
    case (tx_state)
      TX_START: tx_pin = 1'b0;
      TX_DATA:  tx_pin = shreg[0];
      TX_PAR:   tx_pin = parity8(shreg);
      default:  tx_pin = 1'b1;
    endcase
  end
  assign tx_busy = (tx_state != TX_IDLE);

  // ---------------- RX FSM ----------------
  wire rx_s;
  sync2 #(.W(1)) u_sync (.clk(clk), .d(rx_pin), .q(rx_s));

  localparam RX_IDLE = 2'b00, RX_DATA = 2'b01, RX_STOP = 2'b10, RX_ERR = 2'b11;
  reg [1:0] rx_state;
  reg [2:0] rx_idx;
  reg [7:0] rx_sh;

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      rx_state <= RX_IDLE; rx_idx <= 0; rx_sh <= 0; rx_valid <= 0; rx_err <= 0; rx_data <= 0;
    end else begin
      rx_valid <= 1'b0;
      case (rx_state)
        RX_IDLE: if (tick && !rx_s) begin rx_state <= RX_DATA; rx_idx <= 0; end
        RX_DATA: if (tick) begin
                   rx_sh <= {rx_s, rx_sh[7:1]};
                   rx_idx <= rx_idx + 1'b1;
                   if (rx_idx == 3'd7) rx_state <= RX_STOP;
                 end
        RX_STOP: if (tick) begin
                   if (rx_s) begin rx_state <= RX_IDLE; rx_valid <= 1'b1; rx_data <= rx_sh; end
                   else begin rx_state <= RX_ERR; rx_err <= 1'b1; end
                 end
        RX_ERR:  if (tick && rx_s) begin rx_state <= RX_IDLE; rx_err <= 1'b0; end
      endcase
    end
  end

  genvar g;
  generate for (g = 0; g < 2; g = g + 1) begin : dummy
    wire unused = rx_sh[g];
  end endgenerate
endmodule
